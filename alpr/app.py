"""Reconocimiento de patentes gratuito para las playas sin plan de Plate Recognizer.

Usa fast-alpr (licencia MIT): un detector de patentes y un OCR que corren en CPU, sin pagar por
lectura. Es un servicio aparte del back porque es Python; el back lo llama por la red privada de
Railway solo cuando la playa no tiene token de Plate Recognizer, y le reenvía la foto que ya
validó (tipo y tamaño). Este servicio no sabe nada de playas ni de usuarios.

Responde con la misma forma que Plate Recognizer (`image_width`, `image_height`, `results` con
`plate`, `score` y `box`) para que el back elija la patente más centrada con el mismo código.
"""

import hmac
import os
from threading import Lock

import cv2
import numpy as np
from fast_alpr import ALPR
from fastapi import FastAPI, File, Header, HTTPException, UploadFile

# Los dos modelos por defecto de fast-alpr: el OCR global incluye los formatos argentinos.
DETECTOR = "yolo-v9-t-384-license-plate-end2end"
OCR = "cct-xs-v2-global-model"
# fast-alpr usa 0,4. Con cámaras de celular mediocres (ruido, poca luz, foco blando) la patente
# apuntada suele quedar entre 0,3 y 0,4 y se perdía; los recuadros de más que entran con 0,3 se
# descartan solos: el OCR no les encuentra una patente o el back elige la más centrada.
UMBRAL_DETECTOR = 0.3
# El mismo tope que el back: un frame del escáner pesa menos de 1 MB.
MAX_BYTES = 3 * 1024 * 1024
# El recuadro guía del escáner del front (src/utils/plate-scan.ts: ASPECTO_VISOR y ANCHO_GUIA): el
# visor muestra el video recortado a 3:4 y la guía ocupa el 78 % de su ancho, centrada y en 3:1.
# El front sube solo esa parte visible; un cuadro entero (fronts anteriores) da la misma zona,
# porque todo está centrado. Si cambian allá, cambiarlos acá.
ASPECTO_VISOR = 3 / 4
ANCHO_GUIA = 0.78

TOKEN = os.environ.get("ALPR_TOKEN", "")

# Se carga una sola vez al arrancar (los modelos ya vienen bajados en la imagen de Docker).
alpr = ALPR(
    detector_model=DETECTOR, ocr_model=OCR, ocr_device="cpu", detector_conf_thresh=UMBRAL_DETECTOR,
    detector_providers=["CPUExecutionProvider"], ocr_providers=["CPUExecutionProvider"],
)
inferencia = Lock()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/salud")
def salud() -> dict:
    return {"ok": True}


def _zona_guia(ancho: int, alto: int) -> tuple[int, int, int, int]:
    visible = min(ancho, alto * ASPECTO_VISOR)
    w = visible * ANCHO_GUIA
    h = w / 3
    x = (ancho - w) / 2
    y = (alto - h) / 2
    return int(x), int(y), int(x + w), int(y + h)


def _zona_central(ancho: int, alto: int) -> tuple[int, int, int, int]:
    # El cuadrado centrado de lado igual al ancho visible del visor: contiene la guía y algo del
    # paragolpes alrededor, que el detector usa para reconocer una patente.
    lado = min(ancho, alto * ASPECTO_VISOR)
    x = (ancho - lado) / 2
    y = (alto - lado) / 2
    return int(x), int(y), int(x + lado), int(y + lado)


def _iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ancho = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    alto = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    interseccion = ancho * alto
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - interseccion
    return interseccion / union if union > 0 else 0.0


def _detectar(frame: np.ndarray) -> list[tuple[int, int, int, int]]:
    # El detector achica toda la imagen a 384 px de lado. En el cuadro vertical del celular
    # (1080x1920) la patente apuntada le llega cinco veces más chica y, con poca luz o foco blando,
    # no la encuentra. Se busca primero en el cuadrado central, donde está la guía: ahí le llega
    # casi al doble de tamaño. La imagen entera se revisa igual, para fotos con la patente corrida.
    alto, ancho = frame.shape[:2]
    cajas: list[tuple[tuple[int, int, int, int], float]] = []
    for zx1, zy1, zx2, zy2 in (_zona_central(ancho, alto), (0, 0, ancho, alto)):
        for deteccion in alpr.detector.predict(frame[zy1:zy2, zx1:zx2]):
            b = deteccion.bounding_box
            caja = (max(b.x1 + zx1, 0), max(b.y1 + zy1, 0), min(b.x2 + zx1, ancho), min(b.y2 + zy1, alto))
            if caja[2] - caja[0] < 3 or caja[3] - caja[1] < 3:
                continue
            # La misma patente vista en las dos pasadas: queda la detección más segura.
            repetida = next((i for i, (otra, _) in enumerate(cajas) if _iou(caja, otra) > 0.5), None)
            if repetida is None:
                cajas.append((caja, deteccion.confidence))
            elif deteccion.confidence > cajas[repetida][1]:
                cajas[repetida] = (caja, deteccion.confidence)
    return [caja for caja, _ in cajas]


def _confianza(confianza: float | list[float]) -> float:
    # fast-alpr da la confianza de cada carácter: la lectura vale lo que su carácter más dudoso,
    # porque una sola letra mal leída ya es otra patente.
    if isinstance(confianza, list):
        return min(confianza) if confianza else 0.0
    return float(confianza or 0.0)


# Sin `async`: FastAPI la corre en su pool de hilos y la inferencia no frena las demás consultas.
@app.post("/leer")
def leer(imagen: UploadFile = File(...), authorization: str = Header(default="")) -> dict:
    # Sin token configurado no atiende a nadie: el servicio no debe quedar abierto por error.
    if not TOKEN or not hmac.compare_digest(authorization.encode(), f"Bearer {TOKEN}".encode()):
        raise HTTPException(status_code=401, detail="No autorizado.")

    datos = imagen.file.read(MAX_BYTES + 1)
    if len(datos) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="La imagen supera los 3 MB.")
    if not datos:
        raise HTTPException(status_code=400, detail="No se recibió ninguna imagen.")
    try:
        frame = cv2.imdecode(np.frombuffer(datos, np.uint8), cv2.IMREAD_COLOR)
    except cv2.error:
        frame = None
    if frame is None or min(frame.shape[:2]) < 3:
        raise HTTPException(status_code=400, detail="No se pudo leer la imagen.")

    # Una inferencia a la vez: varios operadores no multiplican el consumo de CPU del modelo.
    if not inferencia.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="El lector está ocupado. Probá de nuevo.")
    try:
        return _leer_frame(frame)
    finally:
        inferencia.release()


def _leer_frame(frame: np.ndarray) -> dict:
    lecturas = []
    for x1, y1, x2, y2 in _detectar(frame):
        ocr = alpr.ocr.predict(frame[y1:y2, x1:x2])
        if ocr is None or not ocr.text:
            continue
        lecturas.append(
            {
                "plate": ocr.text.replace("_", "").upper(),
                "score": round(_confianza(ocr.confidence), 4),
                "box": {"xmin": x1, "ymin": y1, "xmax": x2, "ymax": y2},
            }
        )
    alto, ancho = frame.shape[:2]
    # El detector a veces no encuentra la patente (lejos, de costado, poca luz), pero el operador
    # la está apuntando dentro del recuadro guía: se lee directamente esa zona. Con la patente
    # debe llenar buena parte de la guía; las pruebas con recortes no garantizan lecturas en calle.
    if not lecturas:
        x1, y1, x2, y2 = _zona_guia(ancho, alto)
        ocr = alpr.ocr.predict(frame[y1:y2, x1:x2])
        if ocr is not None and ocr.text:
            lecturas.append(
                {
                    "plate": ocr.text.replace("_", "").upper(),
                    "score": round(_confianza(ocr.confidence), 4),
                    "box": {"xmin": x1, "ymin": y1, "xmax": x2, "ymax": y2},
                }
            )
    return {"image_width": ancho, "image_height": alto, "results": lecturas}
