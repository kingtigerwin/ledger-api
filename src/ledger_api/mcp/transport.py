"""Serves one API Gateway request with the MCP SDK's Streamable HTTP transport, stateless and answering in JSON."""

import asyncio
import base64
from typing import Any

from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.types import Message

from ledger_api.http import Event, Response


def serve(server: Server[Any], event: Event) -> Response:
    """
    Hands the request to the SDK as ASGI and collects its answer. Stateless: no session outlives the
    request, so every POST carries the caller's token and gets a server built for that caller.
    """
    return asyncio.run(_serve(server, event))


async def _serve(server: Server[Any], event: Event) -> Response:
    raw = event.get("body") or ""
    body = base64.b64decode(raw) if event.get("isBase64Encoded") else raw.encode()
    headers: dict[str, str] = event.get("headers") or {}
    scope: dict[str, Any] = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        # The route only accepts POST.
        "method": "POST",
        "scheme": "https",
        "path": event.get("rawPath", "/api/mcp"),
        "raw_path": event.get("rawPath", "/api/mcp").encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(name.lower().encode("latin-1"), value.encode("latin-1")) for name, value in headers.items()],
        "server": (headers.get("host", "localhost"), 443),
        "client": None,
    }
    status = 500
    out_headers: dict[str, str] = {}
    chunks: list[bytes] = []
    responded = asyncio.Event()
    received = False

    async def receive() -> Message:
        nonlocal received
        if not received:
            received = True
            return {"type": "http.request", "body": body, "more_body": False}
        await responded.wait()
        return {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        nonlocal status
        if message["type"] == "http.response.start":
            status = int(message["status"])
            out_headers.update((name.decode("latin-1"), value.decode("latin-1")) for name, value in message["headers"])
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))
            if not message.get("more_body"):
                responded.set()

    manager = StreamableHTTPSessionManager(server, json_response=True, stateless=True)
    async with manager.run():
        await manager.handle_request(scope, receive, send)
    return {"statusCode": status, "headers": out_headers, "body": b"".join(chunks).decode()}
