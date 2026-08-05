"""Loopback-only HTTP/WebSocket sentinel for browser-guard qualification."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
from copy import deepcopy
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict
from urllib.parse import urlsplit


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class _LoopbackServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True


class SentinelServer:
    """A disposable server that records metadata but never request content."""

    def __init__(self) -> None:
        self.bind_address = "127.0.0.1"
        self.port = 0
        self.pid = os.getpid()
        self.start_time = ""
        self.stop_time = ""
        self.exit_status = None
        self._requests: list[Dict[str, Any]] = []
        self._lock = threading.Lock()
        self._server = _LoopbackServer((self.bind_address, 0), self._handler_class())
        self._server.sentinel = self
        self.port = int(self._server.server_address[1])
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name=f"sde-qe-sentinel-{self.port}",
            daemon=True,
        )

    def _handler_class(self):
        sentinel_type = type(self)

        class Handler(BaseHTTPRequestHandler):
            server_version = "SDEQESentinel/1"
            sys_version = ""

            def log_message(self, format_string: str, *args: Any) -> None:
                return

            @property
            def sentinel(self) -> "SentinelServer":
                return self.server.sentinel

            def _discard_body(self) -> None:
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    length = 0
                if length > 0:
                    self.rfile.read(length)

            def _record(self, method: str, *, websocket_handshake: bool = False) -> None:
                self.sentinel._record(method, self.path, websocket_handshake=websocket_handshake)

            def _send_bytes(self, status: int, content_type: str, payload: bytes, *, head: bool = False) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
                self.end_headers()
                if not head:
                    self.wfile.write(payload)

            def _html_payload(self, path: str) -> bytes:
                if path == "/login.html":
                    text = """<!doctype html><meta charset=utf-8><title>Local synthetic gate</title>
                    <button id=gate type=button>Continue locally</button>
                    <output id=status>pending</output>
                    <script>gate.onclick=()=>{window.localHumanGate=true;status.textContent='approved';};</script>"""
                elif path == "/popup.html":
                    text = "<!doctype html><meta charset=utf-8><title>Local popup sentinel</title><p>popup</p>"
                elif path == "/matrix.html":
                    text = """<!doctype html><meta charset=utf-8><title>Local read-only matrix</title>
                    <style>body{font:16px sans-serif;margin:0;padding:24px} [hidden]{display:none!important}
                    #scroll-spacer{height:1200px} dialog{border:1px solid #444;padding:20px}</style>
                    <h1 id=page-title role=heading>Read-only matrix</h1>
                    <button id=menu-button role=button type=button aria-label="Open menu" aria-controls=matrix-menu aria-expanded=false>Menu</button>
                    <nav id=matrix-menu role=menu hidden><a href="#summary" role=menuitem>Summary link</a></nav>
                    <section aria-label="Read-only tabs">
                      <button id=tab-summary role=tab type=button aria-selected=true aria-controls=panel-summary>Summary</button>
                      <button id=tab-details role=tab type=button aria-selected=false aria-controls=panel-details>Details</button>
                      <div id=panel-summary role=tabpanel>Summary panel</div>
                      <div id=panel-details role=tabpanel hidden>Details panel</div>
                    </section>
                    <button id=detail-open role=button type=button aria-label="Open read only detail">Detail dialog</button>
                    <div id=detail-dialog role=dialog aria-label="Read only detail" hidden>
                      Read-only detail content
                      <button id=detail-close role=button type=button aria-label="Close detail">Close</button>
                    </div>
                    <button id=popup-open role=button type=button aria-label="Open read only popup">Detail popup</button>
                    <button id=focus-anchor role=button type=button aria-current=false>Focus anchor</button>
                    <form id=danger-form><button id=submit-control role=button type=submit>Save</button>
                      <input id=upload-control type=file aria-label="Upload"></form>
                    <div id=drag-control role=button draggable=true>Drag and drop</div>
                    <div id=editable-control role=textbox contenteditable=true>Editable</div>
                    <div id=scroll-spacer></div><div id=scroll-target role=region title="Scroll target">Scroll target reached</div>
                    <script>
                    const dangerForm=document.querySelector('#danger-form');
                    const menuButton=document.querySelector('#menu-button');
                    const matrixMenu=document.querySelector('#matrix-menu');
                    const tabSummary=document.querySelector('#tab-summary');
                    const tabDetails=document.querySelector('#tab-details');
                    const panelSummary=document.querySelector('#panel-summary');
                    const panelDetails=document.querySelector('#panel-details');
                    const detailOpen=document.querySelector('#detail-open');
                    const detailDialog=document.querySelector('#detail-dialog');
                    const detailClose=document.querySelector('#detail-close');
                    const popupOpen=document.querySelector('#popup-open');
                    const focusAnchor=document.querySelector('#focus-anchor');
                    dangerForm.onsubmit=event=>event.preventDefault();
                    menuButton.onclick=()=>{const open=matrixMenu.hidden;matrixMenu.hidden=!open;menuButton.setAttribute('aria-expanded',String(open));};
                    function selectTab(which){
                      const details=which==='details';
                      tabSummary.setAttribute('aria-selected',String(!details));tabDetails.setAttribute('aria-selected',String(details));
                      panelSummary.hidden=details;panelDetails.hidden=!details;
                    }
                    tabSummary.onclick=()=>selectTab('summary');tabDetails.onclick=()=>selectTab('details');
                    tabSummary.onkeydown=event=>{if(event.key==='ArrowRight'){selectTab('details');tabDetails.focus();}};
                    detailOpen.onclick=()=>{detailDialog.hidden=false;};detailClose.onclick=()=>{detailDialog.hidden=true;};
                    popupOpen.onclick=()=>window.open('/popup.html','_blank');
                    focusAnchor.onfocus=()=>focusAnchor.setAttribute('aria-current','true');
                    focusAnchor.onblur=()=>focusAnchor.setAttribute('aria-current','false');
                    </script>"""
                else:
                    text = "<!doctype html><meta charset=utf-8><title>Local HTTP sentinel</title><p>sentinel</p>"
                return text.encode("utf-8")

            def do_GET(self) -> None:
                if self.headers.get("Upgrade", "").lower() == "websocket":
                    self._record("GET", websocket_handshake=True)
                    key = self.headers.get("Sec-WebSocket-Key", "")
                    accept = base64.b64encode(
                        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
                    ).decode("ascii")
                    self.send_response(101, "Switching Protocols")
                    self.send_header("Upgrade", "websocket")
                    self.send_header("Connection", "Upgrade")
                    self.send_header("Sec-WebSocket-Accept", accept)
                    self.end_headers()
                    return
                path = urlsplit(self.path).path
                self._record("GET")
                if path == "/sw.js":
                    payload = b"self.addEventListener('fetch',()=>{});"
                    self._send_bytes(200, "application/javascript; charset=utf-8", payload)
                elif path.endswith(".html") or path == "/":
                    self._send_bytes(200, "text/html; charset=utf-8", self._html_payload(path))
                else:
                    payload = json.dumps({"ok": True, "path": path}, separators=(",", ":")).encode("utf-8")
                    self._send_bytes(200, "application/json; charset=utf-8", payload)

            def do_HEAD(self) -> None:
                self._record("HEAD")
                self._send_bytes(200, "application/json; charset=utf-8", b"", head=True)

            def _mutation(self, method: str) -> None:
                self._discard_body()
                self._record(method)
                self._send_bytes(204, "application/json; charset=utf-8", b"")

            def do_POST(self) -> None:
                self._mutation("POST")

            def do_PUT(self) -> None:
                self._mutation("PUT")

            def do_PATCH(self) -> None:
                self._mutation("PATCH")

            def do_DELETE(self) -> None:
                self._mutation("DELETE")

            def do_OPTIONS(self) -> None:
                self._mutation("OPTIONS")

            def do_PROPFIND(self) -> None:
                self._mutation("PROPFIND")

        Handler.__name__ = f"{sentinel_type.__name__}Handler"
        return Handler

    @property
    def origin(self) -> str:
        return f"http://{self.bind_address}:{self.port}"

    @property
    def websocket_origin(self) -> str:
        return f"ws://{self.bind_address}:{self.port}"

    def _record(self, method: str, raw_path: str, *, websocket_handshake: bool) -> None:
        entry = {
            "timestamp": utc_now(),
            "method": method,
            "path": urlsplit(raw_path).path or "/",
            "webSocketHandshake": bool(websocket_handshake),
            "reachedServer": True,
        }
        with self._lock:
            self._requests.append(entry)

    def start(self) -> "SentinelServer":
        self.start_time = utc_now()
        self._thread.start()
        return self

    def close(self) -> None:
        if self.exit_status is not None:
            return
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
        self.stop_time = utc_now()
        self.exit_status = 0 if not self._thread.is_alive() else 1

    def __enter__(self) -> "SentinelServer":
        return self.start()

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close()

    def requests(self) -> list[Dict[str, Any]]:
        with self._lock:
            return deepcopy(self._requests)

    def metadata(self) -> Dict[str, Any]:
        return {
            "bindAddress": self.bind_address,
            "port": self.port,
            "pid": self.pid,
            "threadIdentity": self._thread.name,
            "startTime": self.start_time,
            "stopTime": self.stop_time,
            "exitStatus": self.exit_status,
            "threadAlive": self._thread.is_alive(),
        }

    def web_socket_handshake_count(self) -> int:
        return sum(1 for item in self.requests() if item["webSocketHandshake"])

    def reached_methods(self) -> list[str]:
        return [item["method"] for item in self.requests()]
