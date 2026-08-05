#!/usr/bin/env python3
"""Long-lived Browserguard process owning all Playwright objects."""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import stat
import struct
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

from evidence import EvidencePolicyError, EvidenceWriter, _private_temp_parent
from guard import (
    GuardInitializationError,
    GuardPolicyError,
    ProtectedBrowserHarness,
    _broker_screenshot_bytes,
)
from protocol import (
    PROTOCOL_VERSION,
    ProtocolError,
    new_uuid,
    protocol_hash,
    read_frame,
    validate_request,
    write_frame,
)
from runtime_contract import RuntimeContractError, verify_runtime
from sentinel import SentinelServer


class BrowserguardBroker:
    """Own one synthetic protected session and serve one fixed client."""

    def __init__(self) -> None:
        self.session_id = new_uuid()
        self.context_epoch = new_uuid()
        self.state = "STARTING"
        self.evidence = EvidenceWriter.create()
        self._ipc_directory: Optional[Path] = None
        self._socket_path: Optional[Path] = None
        self._listener: Optional[socket.socket] = None
        self._sentinel: Optional[SentinelServer] = None
        self._harness: Optional[ProtectedBrowserHarness] = None
        self._page = None
        self._command_ids: set[str] = set()
        self._last_sequence = 0
        self._hello_complete = False
        self._shutdown_requested = False
        self._runtime_closed = False
        self._profile_deleted = False
        self._browser_disconnected = False
        self._sentinel_stopped = False

    def initialize(self) -> None:
        self._sentinel = SentinelServer().start()
        self._harness = ProtectedBrowserHarness(
            self._sentinel.origin,
            headless=True,
            evidence_directory=self.evidence.root,
        )
        self._harness.start()
        self.state = "BARRIERS_GREEN"
        self._page = self._harness.new_page()
        self._page.goto(f"{self._sentinel.origin}/sentinel.html")
        report = self._harness.report()
        mandatory = (
            report["serviceWorkersBlocked"],
            report["httpBarrierInstalled"],
            report["webSocketBarrierInstalled"],
            report["barriersInstalledBeforeFirstPage"],
        )
        if not all(mandatory):
            raise GuardInitializationError("broker did not establish every pre-page barrier")
        self._create_listener()
        self.state = "READY"

    def _create_listener(self) -> None:
        parent = _private_temp_parent()
        self._ipc_directory = Path(tempfile.mkdtemp(prefix="sde-qe-bg-ipc-", dir=parent))
        self._ipc_directory.chmod(0o700)
        metadata = self._ipc_directory.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o700:
            raise GuardInitializationError("broker IPC directory is not private")
        self._socket_path = self._ipc_directory / "b.sock"
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        previous_umask = os.umask(0o077)
        try:
            listener.bind(str(self._socket_path))
        finally:
            os.umask(previous_umask)
        self._socket_path.chmod(0o600)
        listener.listen(1)
        listener.settimeout(60)
        self._listener = listener

    def startup_metadata(self) -> Dict[str, Any]:
        if self.state != "READY" or self._socket_path is None:
            raise GuardInitializationError("broker is not ready")
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "protocolHash": protocol_hash(),
            "sessionId": self.session_id,
            "socketPath": str(self._socket_path),
            "brokerPid": os.getpid(),
            "state": self.state,
        }

    def _peer_is_owner(self, connection: socket.socket) -> bool:
        if hasattr(connection, "getpeereid"):
            peer_uid, _ = connection.getpeereid()  # type: ignore[attr-defined]
            return int(peer_uid) == os.getuid()
        if hasattr(socket, "SO_PEERCRED"):
            credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            _, peer_uid, _ = struct.unpack("3i", credentials)
            return int(peer_uid) == os.getuid()
        # CPython on macOS does not expose getpeereid(). The broker-created
        # 0700 directory plus 0600 socket remains the portable primary gate.
        return True

    def _barrier_status(self) -> Dict[str, bool]:
        if self._harness is None:
            return {
                "serviceWorkersBlocked": False,
                "httpBarrierInstalled": False,
                "webSocketBarrierInstalled": False,
                "barriersInstalledBeforeFirstPage": False,
            }
        report = self._harness.report()
        return {
            "serviceWorkersBlocked": bool(report["serviceWorkersBlocked"]),
            "httpBarrierInstalled": bool(report["httpBarrierInstalled"]),
            "webSocketBarrierInstalled": bool(report["webSocketBarrierInstalled"]),
            "barriersInstalledBeforeFirstPage": bool(report["barriersInstalledBeforeFirstPage"]),
        }

    def _dispatch(self, request: Dict[str, Any]) -> Dict[str, Any]:
        command = request["command"]
        payload = request["payload"]
        if command != "HELLO" and not self._hello_complete:
            raise GuardPolicyError("HELLO must be the first command")
        handlers = {
            "HELLO": self._hello,
            "STATUS": self._status,
            "CAPTURE_SCREENSHOT": self._capture_screenshot,
            "WRITE_REPORT": self._write_report,
            "SHUTDOWN": self._shutdown,
        }
        return handlers[command](payload)

    def _hello(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self._hello_complete:
            raise GuardPolicyError("HELLO may be sent only once")
        self._hello_complete = True
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "protocolHash": protocol_hash(),
            "brokerPid": os.getpid(),
            "state": self.state,
        }

    def _status(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "state": self.state,
            "brokerPid": os.getpid(),
            "contextEpoch": self.context_epoch,
            "pageCount": 1 if self._page is not None else 0,
            "barrierStatus": self._barrier_status(),
            "evidenceDirectory": str(self.evidence.root),
        }

    def _capture_screenshot(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self._page is None:
            raise GuardPolicyError("active page is unavailable")
        value = _broker_screenshot_bytes(self._page)
        result = self.evidence.write_artifact(payload["artifactId"], "screenshot-png", value)
        return {
            "artifactId": result.artifact_id,
            "filename": result.filename,
            "byteCount": result.byte_count,
        }

    def _write_report(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self._harness is None:
            raise GuardPolicyError("browserguard report is unavailable")
        value = (json.dumps(self._harness.report(), indent=2, sort_keys=True) + "\n").encode("utf-8")
        result = self.evidence.write_artifact(payload["artifactId"], "json", value)
        return {
            "artifactId": result.artifact_id,
            "filename": result.filename,
            "byteCount": result.byte_count,
        }

    def _shutdown(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self.state = "CLOSING"
        self._close_runtime()
        report = self._final_report_bytes()
        result = self.evidence.write_artifact("browserguard-report", "json", report)
        self.state = "CLOSED"
        self._shutdown_requested = True
        return {
            "state": self.state,
            "profileDeleted": self._profile_deleted,
            "browserDisconnected": self._browser_disconnected,
            "sentinelStopped": self._sentinel_stopped,
            "evidenceDirectory": str(self.evidence.root),
            "reportFilename": result.filename,
        }

    def _final_report_bytes(self) -> bytes:
        report = self._harness.report() if self._harness is not None else {}
        report["brokerSessionId"] = self.session_id
        report["brokerPid"] = os.getpid()
        report["brokerState"] = "CLOSED"
        return (json.dumps(report, indent=2, sort_keys=True) + "\n").encode("utf-8")

    def _close_runtime(self) -> None:
        if self._runtime_closed:
            return
        self._runtime_closed = True
        if self._harness is not None:
            self._harness.close()
            report = self._harness.report()
            self._profile_deleted = bool(report["profileDirectoryDeleted"])
            self._browser_disconnected = bool(report["browserDisconnected"])
        else:
            self._profile_deleted = True
            self._browser_disconnected = True
        if self._sentinel is not None:
            self._sentinel.close()
            self._sentinel_stopped = self._sentinel.metadata()["exitStatus"] == 0
        else:
            self._sentinel_stopped = True

    def _success_response(self, request: Dict[str, Any], result: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": self.session_id,
            "responseId": new_uuid(),
            "responseTo": request["commandId"],
            "sequence": request["sequence"],
            "ok": True,
            "result": result,
            "error": None,
        }

    def _error_response(self, request: Dict[str, Any], code: str, message: str) -> Dict[str, Any]:
        command_id = request.get("commandId")
        sequence = request.get("sequence")
        if not isinstance(command_id, str):
            command_id = new_uuid()
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
            sequence = max(1, self._last_sequence + 1)
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "sessionId": self.session_id,
            "responseId": new_uuid(),
            "responseTo": command_id,
            "sequence": sequence,
            "ok": False,
            "result": None,
            "error": {"code": code, "message": message[:300] or "request rejected"},
        }

    def serve(self) -> None:
        if self._listener is None:
            raise GuardInitializationError("broker listener is unavailable")
        connection, _ = self._listener.accept()
        with connection:
            if not self._peer_is_owner(connection):
                raise GuardPolicyError("broker peer UID did not match")
            while not self._shutdown_requested:
                try:
                    raw = read_frame(connection)
                except EOFError:
                    break
                try:
                    request = validate_request(raw, expected_session_id=self.session_id)
                    command_id = request["commandId"]
                    sequence = request["sequence"]
                    if command_id in self._command_ids or sequence != self._last_sequence + 1:
                        raise ProtocolError("command replay or sequence mismatch")
                    self._command_ids.add(command_id)
                    self._last_sequence = sequence
                    result = self._dispatch(request)
                    response = self._success_response(request, result)
                except (ProtocolError, GuardPolicyError, EvidencePolicyError) as error:
                    response = self._error_response(raw, "INVALID_REQUEST", str(error))
                except Exception:
                    response = self._error_response(raw, "INTERNAL_ERROR", "broker command failed closed")
                write_frame(connection, response)

    def close(self) -> None:
        self._close_runtime()
        if self._listener is not None:
            self._listener.close()
            self._listener = None
        if self._socket_path is not None:
            try:
                self._socket_path.unlink()
            except FileNotFoundError:
                pass
        if self._ipc_directory is not None:
            shutil.rmtree(self._ipc_directory, ignore_errors=True)
        self.evidence.close()


def main() -> int:
    broker: Optional[BrowserguardBroker] = None
    try:
        verify_runtime()
        broker = BrowserguardBroker()
        broker.initialize()
        print(json.dumps(broker.startup_metadata(), sort_keys=True), flush=True)
        broker.serve()
        return 0
    except (RuntimeContractError, GuardInitializationError, GuardPolicyError, ProtocolError) as error:
        print(json.dumps({"status": "BLOCKED", "error": str(error)}, sort_keys=True), file=sys.stderr)
        return 1
    finally:
        if broker is not None:
            broker.close()


def _termination_signal(signum: int, frame: object) -> None:
    raise SystemExit(128 + signum)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.default_int_handler)
    signal.signal(signal.SIGTERM, _termination_signal)
    sys.exit(main())
