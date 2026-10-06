"""Arranque del servicio escuchando a la vez en IPv4 y en IPv6.

`uvicorn --host ::` deja el socket solo en IPv6, y `--host 0.0.0.0` solo en IPv4. La red privada
de Railway entre servicios es IPv6 en los entornos viejos y doble en los nuevos, y Docker en local
entra por IPv4: un socket IPv6 con IPV6_V6ONLY apagado atiende las dos.
"""

import os
import socket

import uvicorn

puerto = int(os.environ.get("PORT", "8000"))
sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("::", puerto))

uvicorn.Server(uvicorn.Config("app:app", host="::", port=puerto)).run(sockets=[sock])
