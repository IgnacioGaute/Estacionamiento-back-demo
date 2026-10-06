# Servicio de reconocimiento de patentes gratuito (fast-alpr). En Railway es un servicio aparte con
# «Root Directory» = alpr. Ver alpr/README.md.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py serve.py ./
# Importar la app construye ALPR, que baja los dos modelos (unos 10 MB). Se hace en el build para
# que el servicio arranque sin depender de GitHub y siempre con los mismos modelos.
RUN python -c "import app"

EXPOSE 8000
# serve.py escucha en IPv4 e IPv6 a la vez (ver el comentario ahí).
CMD ["python", "serve.py"]
