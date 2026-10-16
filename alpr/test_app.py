"""Pruebas de contrato del servicio; las inferencias se simulan, sin descargar fotos."""
import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np
from fastapi import HTTPException, UploadFile
import app

class LectorTest(unittest.TestCase):
    def setUp(self):
        self.token = patch.object(app, "TOKEN", "secreto-test")
        self.token.start()
        self.addCleanup(self.token.stop)
        self.jpeg = cv2.imencode(".jpg", np.zeros((120, 240, 3), dtype=np.uint8))[1].tobytes()

    def leer(self, datos=None, authorization="Bearer secreto-test"):
        return app.leer(UploadFile(filename="patente.jpg", file=io.BytesIO(self.jpeg if datos is None else datos)), authorization)

    def test_auth(self):
        for valor in ["", "Bearer otro", "Bearer secreto-test-extra"]:
            with self.assertRaises(HTTPException) as err:
                self.leer(authorization=valor)
            self.assertEqual(err.exception.status_code, 401)
        with patch.object(app, "TOKEN", ""), self.assertRaises(HTTPException) as err:
            self.leer()
        self.assertEqual(err.exception.status_code, 401)

    def test_fotos_invalidas(self):
        for datos in [b"", b"archivo cualquiera"]:
            with self.assertRaises(HTTPException) as err:
                self.leer(datos)
            self.assertEqual(err.exception.status_code, 400)
        with self.assertRaises(HTTPException) as err:
            self.leer(b"x" * (app.MAX_BYTES + 1))
        self.assertEqual(err.exception.status_code, 413)

    def test_confianza(self):
        self.assertEqual(app._confianza([0.99, 0.81, 0.94]), 0.81)
        self.assertEqual(app._confianza([]), 0)
        self.assertEqual(app._confianza(0.93), 0.93)

    def test_detector_y_no_fallback(self):
        deteccion = SimpleNamespace(confidence=0.9, bounding_box=SimpleNamespace(x1=80, y1=50, x2=170, y2=90))
        ocr = SimpleNamespace(text="ab123cd_", confidence=[0.98, 0.95])
        with patch.object(app.alpr.detector, "predict", side_effect=[[], [deteccion]]), patch.object(app.alpr.ocr, "predict", return_value=ocr) as lector:
            resultado = self.leer()
        self.assertEqual(resultado["image_width"], 240)
        self.assertEqual(resultado["image_height"], 120)
        self.assertEqual(resultado["results"], [{"plate": "AB123CD", "score": 0.95, "box": {"xmin": 80, "ymin": 50, "xmax": 170, "ymax": 90}}])
        # Una sola lectura, sobre el recuadro detectado: no hubo fallback a la guía.
        lector.assert_called_once()
        self.assertEqual(lector.call_args[0][0].shape[:2], (40, 90))

    def test_zona_central(self):
        # Cuadro vertical 1080x1920: el visor 3:4 deja ver todo el ancho; el cuadrado es de 1080.
        self.assertEqual(app._zona_central(1080, 1920), (0, 420, 1080, 1500))
        # Solo la parte visible (1080x1440), como la sube el front: el mismo cuadrado centrado.
        self.assertEqual(app._zona_central(1080, 1440), (0, 180, 1080, 1260))
        # Foto horizontal: el cuadrado toma el ancho que se vería en el visor.
        self.assertEqual(app._zona_central(240, 120), (75, 15, 165, 105))

    def test_detecta_en_el_centro_y_en_la_imagen_entera(self):
        # En el cuadrado central (75, 15) la patente aparece con coordenadas relativas a ese recorte;
        # en la imagen entera, la misma patente con menos confianza y otra en una esquina.
        centro = SimpleNamespace(confidence=0.8, bounding_box=SimpleNamespace(x1=10, y1=30, x2=80, y2=55))
        misma = SimpleNamespace(confidence=0.35, bounding_box=SimpleNamespace(x1=86, y1=46, x2=154, y2=69))
        esquina = SimpleNamespace(confidence=0.9, bounding_box=SimpleNamespace(x1=0, y1=0, x2=40, y2=20))
        with patch.object(app.alpr.detector, "predict", side_effect=[[centro], [misma, esquina]]) as detector:
            cajas = app._detectar(np.zeros((120, 240, 3), dtype=np.uint8))
        self.assertEqual([c.args[0].shape[:2] for c in detector.call_args_list], [(90, 90), (120, 240)])
        self.assertEqual(cajas, [(85, 45, 155, 70), (0, 0, 40, 20)])

    def test_descarta_la_patente_cortada_por_el_cuadrado_central(self):
        # Cuadrado central (75, 15, 165, 105): esta patente sigue a la derecha del recorte (el
        # detector la corta a unos píxeles del borde) y su OCR sería incompleto. Queda la de la
        # imagen entera, aunque el detector la vea menos segura.
        cortada = SimpleNamespace(confidence=0.9, bounding_box=SimpleNamespace(x1=40, y1=30, x2=87, y2=55))
        entera = SimpleNamespace(confidence=0.35, bounding_box=SimpleNamespace(x1=110, y1=44, x2=200, y2=71))
        with patch.object(app.alpr.detector, "predict", side_effect=[[cortada], [entera]]):
            self.assertEqual(app._detectar(np.zeros((120, 240, 3), dtype=np.uint8)), [(110, 44, 200, 71)])
        # Si el borde del recorte es el de la imagen (cuadro vertical), la patente no está cortada.
        al_borde = SimpleNamespace(confidence=0.9, bounding_box=SimpleNamespace(x1=0, y1=30, x2=60, y2=50))
        with patch.object(app.alpr.detector, "predict", side_effect=[[al_borde], []]):
            self.assertEqual(app._detectar(np.zeros((120, 90, 3), dtype=np.uint8)), [(0, 45, 60, 65)])

    def test_fallback_guia(self):
        ocr = SimpleNamespace(text="abc123_", confidence=[0.98, 0.86])
        with patch.object(app.alpr.detector, "predict", return_value=[]), patch.object(app.alpr.ocr, "predict", return_value=ocr) as fallback:
            resultado = self.leer()
        x1, y1, x2, y2 = app._zona_guia(240, 120)
        self.assertEqual(fallback.call_args[0][0].shape[:2], (y2-y1, x2-x1))
        self.assertEqual(resultado["results"][0]["plate"], "ABC123")
        self.assertEqual(resultado["results"][0]["score"], 0.86)

    def test_no_patente(self):
        with patch.object(app.alpr.detector, "predict", return_value=[]), patch.object(app.alpr.ocr, "predict", return_value=None):
            self.assertEqual(self.leer()["results"], [])

    def test_ocupado_y_libera_si_falla(self):
        app.inferencia.acquire()
        try:
            with self.assertRaises(HTTPException) as err:
                self.leer()
            self.assertEqual(err.exception.status_code, 429)
        finally:
            app.inferencia.release()
        with patch.object(app.alpr.detector, "predict", side_effect=RuntimeError("Modelo falló")), self.assertRaises(RuntimeError):
            self.leer()
        self.assertFalse(app.inferencia.locked())

if __name__ == "__main__":
    unittest.main()
