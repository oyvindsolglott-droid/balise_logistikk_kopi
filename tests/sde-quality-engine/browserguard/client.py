"""Narrow client for the separate Browserguard process."""

from __future__ import annotations

import json
import os
import selectors
import signal
import socket
import subprocess
import sys
import time
import re
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Optional

from evidence import ARTIFACT_ID_PATTERN
from protocol import (
    PROTOCOL_VERSION,
    ProtocolError,
    new_uuid,
    protocol_hash,
    read_frame,
    validate_response,
    validate_startup,
    write_frame,
)


PUBLIC_CLIENT_API = frozenset(
    {
        "begin_human_gate",
        "capture_screenshot",
        "close",
        "complete_human_gate",
        "count_elements",
        "execute_action",
        "is_visible",
        "list_pages",
        "navigate",
        "read_attribute",
        "read_text",
        "scroll",
        "select_page",
        "set_viewport",
        "start",
        "status",
        "wait_load_state",
        "write_report",
    }
)
_RESULT_FIELDS = {
    "HELLO": frozenset({"protocolVersion", "protocolHash", "brokerPid", "state"}),
    "STATUS": frozenset(
        {"state", "brokerPid", "contextEpoch", "pageCount", "barrierStatus", "evidenceDirectory"}
    ),
    "CAPTURE_SCREENSHOT": frozenset({"artifactId", "filename", "byteCount"}),
    "WRITE_REPORT": frozenset({"artifactId", "filename", "byteCount"}),
    "NAVIGATE": frozenset({"actionId", "origin", "path", "status", "ok", "activePageId"}),
    "READ_TEXT": frozenset({"targetId", "text"}),
    "READ_ATTRIBUTE": frozenset({"targetId", "attribute", "value"}),
    "COUNT_ELEMENTS": frozenset({"targetId", "count"}),
    "IS_VISIBLE": frozenset({"targetId", "visible"}),
    "SET_VIEWPORT": frozenset({"viewportId", "width", "height"}),
    "SCROLL": frozenset({"targetId", "direction"}),
    "WAIT_LOAD_STATE": frozenset({"state"}),
    "EXECUTE_ACTION": frozenset({"actionId", "actionType", "activePageId", "pageCount"}),
    "LIST_PAGES": frozenset({"pages", "activePageId"}),
    "SELECT_PAGE": frozenset({"activePageId"}),
    "HUMAN_GATE_BEGIN": frozenset({"state", "brokerPid", "contextEpoch", "activePageId"}),
    "HUMAN_GATE_COMPLETE": frozenset({"state", "brokerPid", "contextEpoch", "activePageId"}),
    "SHUTDOWN": frozenset(
        {
            "state",
            "profileDeleted",
            "browserDisconnected",
            "sentinelStopped",
            "evidenceDirectory",
            "reportFilename",
        }
    ),
}


class BrowserguardClientError(RuntimeError):
    """Raised when broker startup, transport or policy validation fails."""


def _assert_json_dto(value: Any) -> None:
    if value is None or isinstance(value, (str, bool, int, float)):
        return
    if isinstance(value, list):
        for item in value:
            _assert_json_dto(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise BrowserguardClientError("broker DTO contained a non-string key")
            _assert_json_dto(item)
        return
    raise BrowserguardClientError("broker DTO contained a non-JSON type")


class BrowserguardClient:
    """Fixed process launcher and command-specific protocol facade."""

    def __init__(self) -> None:
        self._process: Optional[subprocess.Popen[str]] = None
        self._connection: Optional[socket.socket] = None
        self._startup: Optional[Dict[str, Any]] = None
        self._sequence = 0
        self._response_ids: set[str] = set()
        self._closed = False

    def __enter__(self) -> "BrowserguardClient":
        return self.start()

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        raise BrowserguardClientError(f"client operation '{name}' is not allowlisted")

    def start(self) -> "BrowserguardClient":
        if self._closed:
            raise BrowserguardClientError("closed client cannot be restarted")
        if self._process is not None:
            return self
        broker_path = Path(__file__).resolve().with_name("broker.py")
        environment = dict(os.environ)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        process = subprocess.Popen(
            [sys.executable, "-B", str(broker_path)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=environment,
            start_new_session=True,
        )
        self._process = process
        try:
            line = self._read_startup_line(process, timeout_seconds=60)
            startup = validate_startup(json.loads(line))
            if startup["brokerPid"] != process.pid:
                raise BrowserguardClientError("startup PID did not match child process")
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.settimeout(10)
            connection.connect(startup["socketPath"])
            self._connection = connection
            self._startup = startup
            self._hello()
            return self
        except Exception as error:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
            self._terminate_process()
            stderr = self._stderr_text()
            self._close_pipes()
            detail = f"; broker stderr: {stderr}" if stderr else ""
            raise BrowserguardClientError(f"broker startup failed: {error}{detail}") from error

    def _read_startup_line(
        self, process: subprocess.Popen[str], *, timeout_seconds: float
    ) -> str:
        if process.stdout is None:
            raise BrowserguardClientError("broker stdout pipe is unavailable")
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            events = selector.select(timeout_seconds)
            if not events:
                raise BrowserguardClientError("broker startup timed out")
            line = process.stdout.readline(8193)
        finally:
            selector.close()
        if not line or len(line) > 8192:
            stderr = process.stderr.read(2048) if process.stderr is not None else ""
            raise BrowserguardClientError(f"broker emitted no valid startup metadata: {stderr.strip()}")
        return line

    def _request(self, command: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self._connection is None or self._startup is None:
            raise BrowserguardClientError("broker connection is unavailable")
        self._sequence += 1
        command_id = new_uuid()
        request = {
            "protocolVersion": PROTOCOL_VERSION,
            "protocolHash": protocol_hash(),
            "sessionId": self._startup["sessionId"],
            "commandId": command_id,
            "sequence": self._sequence,
            "command": command,
            "payload": payload,
        }
        try:
            write_frame(self._connection, request)
            raw = read_frame(self._connection)
            response = validate_response(
                raw,
                expected_session_id=self._startup["sessionId"],
                expected_command_id=command_id,
                expected_sequence=self._sequence,
            )
            response_id = response["responseId"]
            if response_id in self._response_ids:
                raise ProtocolError("response ID was reused within the broker session")
            self._response_ids.add(response_id)
        except (OSError, EOFError, ProtocolError) as error:
            raise BrowserguardClientError(f"broker protocol failed: {error}") from error
        if not response["ok"]:
            raise BrowserguardClientError(
                f"{response['error']['code']}: {response['error']['message']}"
            )
        result = response["result"]
        if command not in _RESULT_FIELDS or set(result) != _RESULT_FIELDS[command]:
            raise BrowserguardClientError("broker result fields are invalid")
        if command == "STATUS":
            expected = {
                "serviceWorkersBlocked",
                "httpBarrierInstalled",
                "webSocketBarrierInstalled",
                "barriersInstalledBeforeFirstPage",
            }
            if not isinstance(result["barrierStatus"], dict) or set(result["barrierStatus"]) != expected:
                raise BrowserguardClientError("broker barrier status fields are invalid")
        if command == "LIST_PAGES":
            page_fields = {"pageId", "origin", "path", "title", "active"}
            if not isinstance(result["pages"], list) or any(
                not isinstance(item, dict) or set(item) != page_fields for item in result["pages"]
            ):
                raise BrowserguardClientError("broker page DTO fields are invalid")
        _assert_json_dto(result)
        return deepcopy(result)

    def _hello(self) -> Dict[str, Any]:
        result = self._request("HELLO", {})
        if result["protocolVersion"] != PROTOCOL_VERSION or result["protocolHash"] != protocol_hash():
            raise BrowserguardClientError("broker HELLO version or hash mismatch")
        return result

    def status(self) -> Dict[str, Any]:
        return self._request("STATUS", {})

    def navigate(self, action_id: str) -> Dict[str, Any]:
        self._assert_plan_id(action_id)
        return self._request("NAVIGATE", {"actionId": action_id})

    def read_text(self, target_id: str) -> Dict[str, Any]:
        self._assert_plan_id(target_id)
        return self._request("READ_TEXT", {"targetId": target_id})

    def read_attribute(self, target_id: str, attribute: str) -> Dict[str, Any]:
        self._assert_plan_id(target_id)
        if not isinstance(attribute, str) or (
            attribute not in {"alt", "class", "id", "role", "title"}
            and re.fullmatch(r"aria-[a-z-]+", attribute) is None
        ):
            raise BrowserguardClientError("attribute is not allowlisted")
        return self._request("READ_ATTRIBUTE", {"targetId": target_id, "attribute": attribute})

    def count_elements(self, target_id: str) -> Dict[str, Any]:
        self._assert_plan_id(target_id)
        return self._request("COUNT_ELEMENTS", {"targetId": target_id})

    def is_visible(self, target_id: str) -> Dict[str, Any]:
        self._assert_plan_id(target_id)
        return self._request("IS_VISIBLE", {"targetId": target_id})

    def set_viewport(self, viewport_id: str) -> Dict[str, Any]:
        self._assert_plan_id(viewport_id)
        return self._request("SET_VIEWPORT", {"viewportId": viewport_id})

    def scroll(self, target_id: str, direction: str) -> Dict[str, Any]:
        self._assert_plan_id(target_id)
        if direction not in {"UP", "DOWN"}:
            raise BrowserguardClientError("scroll direction is not allowlisted")
        return self._request("SCROLL", {"targetId": target_id, "direction": direction})

    def wait_load_state(self, state: str) -> Dict[str, Any]:
        if state not in {"domcontentloaded", "load", "networkidle"}:
            raise BrowserguardClientError("load state is not allowlisted")
        return self._request("WAIT_LOAD_STATE", {"state": state})

    def execute_action(self, action_id: str) -> Dict[str, Any]:
        self._assert_plan_id(action_id)
        return self._request("EXECUTE_ACTION", {"actionId": action_id})

    def list_pages(self) -> Dict[str, Any]:
        return self._request("LIST_PAGES", {})

    def select_page(self, page_id: str) -> Dict[str, Any]:
        if not isinstance(page_id, str) or re.fullmatch(
            r"page-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            page_id,
        ) is None:
            raise BrowserguardClientError("page ID is invalid")
        return self._request("SELECT_PAGE", {"pageId": page_id})

    def begin_human_gate(self) -> Dict[str, Any]:
        return self._request("HUMAN_GATE_BEGIN", {})

    def complete_human_gate(self) -> Dict[str, Any]:
        return self._request("HUMAN_GATE_COMPLETE", {})

    def capture_screenshot(self, artifact_id: str) -> Dict[str, Any]:
        self._assert_artifact_id(artifact_id)
        return self._request("CAPTURE_SCREENSHOT", {"artifactId": artifact_id})

    def write_report(self, artifact_id: str) -> Dict[str, Any]:
        self._assert_artifact_id(artifact_id)
        return self._request("WRITE_REPORT", {"artifactId": artifact_id})

    def _assert_artifact_id(self, artifact_id: str) -> None:
        if not isinstance(artifact_id, str) or re.fullmatch(ARTIFACT_ID_PATTERN, artifact_id) is None:
            raise BrowserguardClientError("artifact ID is not allowlisted")

    def _assert_plan_id(self, identifier: str) -> None:
        if not isinstance(identifier, str) or re.fullmatch(ARTIFACT_ID_PATTERN, identifier) is None:
            raise BrowserguardClientError("plan identifier is not allowlisted")

    def close(self) -> Dict[str, Any]:
        if self._closed:
            return {}
        self._closed = True
        shutdown: Dict[str, Any] = {}
        try:
            if self._connection is not None and self._startup is not None:
                shutdown = self._request("SHUTDOWN", {})
        except BrowserguardClientError:
            shutdown = {}
        finally:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
            self._wait_or_terminate()
        return shutdown

    def _wait_or_terminate(self) -> None:
        process = self._process
        if process is None:
            return
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self._terminate_process()
        if process.returncode not in {0, None}:
            stderr = self._stderr_text()
            self._close_pipes()
            raise BrowserguardClientError(f"broker exited with {process.returncode}: {stderr.strip()}")
        self._close_pipes()

    def _terminate_process(self) -> None:
        process = self._process
        if process is None or process.poll() is not None:
            return
        try:
            process.wait(timeout=5)
            return
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=5)

    def _stderr_text(self) -> str:
        process = self._process
        if process is None or process.stderr is None:
            return ""
        try:
            return process.stderr.read(2048).strip()
        except (OSError, ValueError):
            return ""

    def _close_pipes(self) -> None:
        process = self._process
        if process is None:
            return
        for stream in (process.stdout, process.stderr):
            if stream is not None and not stream.closed:
                stream.close()
