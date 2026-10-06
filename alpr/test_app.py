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
        caja = SimpleNamespace(x1=80, y1=50, x2=170, y2=90)
        lectura = SimpleNamespace(detection=SimpleNamespace(bounding_box=caja), ocr=SimpleNamespace(text="ab123cd_", confidence=[0.98, 0.95]))
        with patch.object(app.alpr, "predict", return_value=[lectura]), patch.object(app.alpr.ocr, "predict") as fallback:
            resultado = self.leer()
        self.assertEqual(resultado["image_width"], 240)
        self.assertEqual(resultado["image_height"], 120)
        self.assertEqual(resultado["results"], [{"plate": "AB123CD", "score": 0.95, "box": {"xmin": 80, "ymin": 50, "xmax": 170, "ymax": 90}}])
        fallback.assert_not_called()

    def test_fallback_guia(self):
        ocr = SimpleNamespace(text="abc123_", confidence=[0.98, 0.86])
        with patch.object(app.alpr, "predict", return_value=[]), patch.object(app.alpr.ocr, "predict", return_value=ocr) as fallback:
            resultado = self.leer()
        x1, y1, x2, y2 = app._zona_guia(240, 120)
        self.assertEqual(fallback.call_args[0][0].shape[:2], (y2-y1, x2-x1))
        self.assertEqual(resultado["results"][0]["plate"], "ABC123")
        self.assertEqual(resultado["results"][0]["score"], 0.86)

    def test_no_patente(self):
        with patch.object(app.alpr, "predict", return_value=[]), patch.object(app.alpr.ocr, "predict", return_value=None):
            self.assertEqual(self.leer()["results"], [])

    def test_ocupado_y_libera_si_falla(self):
        app.inferencia.acquire()
        try:
            with self.assertRaises(HTTPException) as err:
                self.leer()
            self.assertEqual(err.exception.status_code, 429)
        finally:
            app.inferencia.release()
        with patch.object(app.alpr, "predict", side_effect=RuntimeError("Modelo falló")), self.assertRaises(RuntimeError):
            self.leer()
        self.assertFalse(app.inferencia.locked())

if __name__ == "__main__":
    unittest.main()
