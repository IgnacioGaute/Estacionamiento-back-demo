# Reconocimiento de patentes para playas sin token

El backend elige el motor automáticamente por playa:

- Con token propio: Plate Recognizer, usando el plan de esa playa.
- Sin token: fast-alpr, si ALPR_URL y ALPR_TOKEN están configurados en el backend.
- Sin ninguno: escritura manual; no se ofrece una cámara que no pueda leer.

No hace falta activar un adicional ni cargar un token de Plate Recognizer para usar fast-alpr. En celular aparece «Escanear patente con la cámara». La lectura completa el campo para que el operador lo revise; no registra una entrada ni cobra automáticamente. La ficha de empresa indica «Reconocimiento gratuito» para las playas sin token cuando el motor está configurado.

El software fast-alpr es MIT y no cobra por lectura. El servidor que lo ejecuta sí consume CPU, memoria y alojamiento. La calidad con autos reales depende del encuadre, iluminación y patente; no hay una precisión garantizada. El operador siempre puede corregir el resultado o escribir la patente.

## Local con Docker

En el .env del backend:

    ALPR_URL=http://127.0.0.1:8791
    ALPR_TOKEN=<secreto aleatorio compartido>

Generar un secreto con node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" y guardarlo sólo en .env. No usar NEXT_PUBLIC ni cargarlo en el frontend.

Desde la raíz del backend:

    docker compose -f docker-compose.alpr.yaml up -d --build

Ese archivo inicia sólo el reconocimiento, sin tocar PostgreSQL. Publica el puerto en 127.0.0.1, no en la red. Comprueba salud con GET http://127.0.0.1:8791/salud. El contenedor toma ALPR_TOKEN del mismo .env.

Reiniciar el backend después de cambiar sus variables y recargar el frontend para renovar el contexto de la playa. La cámara en vivo requiere HTTPS o localhost; en una dirección LAN por HTTP se ofrece la captura de foto del celular.

## Railway

1. Crear un servicio del mismo repositorio y entorno, con Root Directory = /alpr y Dockerfile = Dockerfile.
2. En ese servicio configurar PORT=8000 y ALPR_TOKEN con un secreto aleatorio. Configurar /salud como healthcheck. No necesita dominio público ni PostgreSQL.
3. En el backend agregar ALPR_URL=http://<nombre-del-servicio>.railway.internal:8000 y el mismo ALPR_TOKEN. Usar el dominio privado real del servicio.
4. Desplegar el servicio de reconocimiento, backend y frontend. El Dockerfile descarga los modelos al construir; no los vuelve a descargar al leer una foto.
5. Recargar la sesión del operador en celular: una playa sin token debe mostrar la cámara. Si se quita un token, vuelve al motor de la plataforma mientras esté configurado.

El proceso escucha en IPv4 e IPv6 para funcionar tanto en Docker como en la red privada de Railway. ALPR_URL declara que el servicio está configurado, no confirma su salud en tiempo real: si cae, la cámara informa el problema y permite escritura manual.

## API y límites

GET /salud devuelve ok una vez cargados los modelos. POST /leer recibe un multipart con campo imagen y Authorization: Bearer ALPR_TOKEN. Acepta hasta 3 MB y devuelve dimensiones, texto, confianza y recuadro; el backend sólo devuelve la patente elegida y confianza al operador. No guarda imágenes ni conoce usuarios, empresas o playas.

Se ejecuta en CPU, con una inferencia simultánea. Si está ocupado responde 429; el escáner espera y reintenta dentro de su límite de intentos. Si el detector no encuentra patentes, el OCR prueba el recuadro central con la misma geometría que src/utils/plate-scan.ts en el frontend (visor 3:4, guía de 78 %, proporción 3:1). Si esas constantes cambian, ajustar también app.py. No se usan lecturas como confirmación de identidad de un vehículo.

## Pruebas

Construir la imagen y ejecutar las pruebas aisladas:

    docker build -t parking-alpr-test alpr
    docker run --rm --mount type=bind,source=<ruta absoluta a alpr>,target=/tests,readonly parking-alpr-test python /tests/test_app.py

Cubren autenticación, límites de imagen, confianza, fallback, selección de recuadros y concurrencia. Las pruebas de Nest cubren selección de motor, errores y precedencia del token propio; test/tenant-isolation.integration.cjs verifica el contexto y el endpoint por playa. Para comprobar modelos reales, enviar una foto al endpoint con el secreto del entorno; el resultado debe revisarse a mano.

Referencias: https://github.com/ankandrew/fast-alpr y https://docs.railway.com/networking/private-networking.
