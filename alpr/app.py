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
# El mismo tope que el back: un frame del escáner pesa menos de 1 MB.
MAX_BYTES = 3 * 1024 * 1024
# El recuadro guía del escáner del front (src/utils/plate-scan.ts: ASPECTO_VISOR y ANCHO_GUIA): el
# visor muestra el video recortado a 3:4 y la guía ocupa el 78 % de su ancho, centrada y en 3:1.
# Si cambian allá, cambiarlos acá.
ASPECTO_VISOR = 3 / 4
ANCHO_GUIA = 0.78

TOKEN = os.environ.get("ALPR_TOKEN", "")

# Se carga una sola vez al arrancar (los modelos ya vienen bajados en la imagen de Docker).
alpr = ALPR(
    detector_model=DETECTOR, ocr_model=OCR, ocr_device="cpu",
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
    for resultado in alpr.predict(frame):
        if resultado.ocr is None or not resultado.ocr.text:
            continue
        caja = resultado.detection.bounding_box
        lecturas.append(
            {
                "plate": resultado.ocr.text.replace("_", "").upper(),
                "score": round(_confianza(resultado.ocr.confidence), 4),
                "box": {"xmin": caja.x1, "ymin": caja.y1, "xmax": caja.x2, "ymax": caja.y2},
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
