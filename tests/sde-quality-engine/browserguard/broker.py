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
    _page_state,
    origin_from_url,
    sanitized_path,
)
from interaction_plan import (
    InteractionPlanError,
    ReadOnlyInteractionPlan,
    validate_element_policy,
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
        self._plan: Optional[ReadOnlyInteractionPlan] = None
        self._pages: Dict[str, Any] = {}
        self._active_page_id = ""
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
        self._plan = ReadOnlyInteractionPlan.synthetic(target_origin=self._sentinel.origin)
        self._harness = ProtectedBrowserHarness(
            self._sentinel.origin,
            headless=True,
            evidence_directory=self.evidence.root,
        )
        self._harness.start()
        self.state = "BARRIERS_GREEN"
        self._page = self._harness.new_page()
        self._page.goto(f"{self._sentinel.origin}/sentinel.html")
        _, raw_page = _page_state(self._page)
        self._active_page_id = self._register_page(raw_page)
        if self._harness._context is None:
            raise GuardInitializationError("broker context is unavailable")
        self._harness._context.on("page", self._register_page)
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
            "NAVIGATE": self._navigate,
            "READ_TEXT": self._read_text,
            "READ_ATTRIBUTE": self._read_attribute,
            "COUNT_ELEMENTS": self._count_elements,
            "IS_VISIBLE": self._is_visible,
            "SET_VIEWPORT": self._set_viewport,
            "SCROLL": self._scroll,
            "WAIT_LOAD_STATE": self._wait_load_state,
            "EXECUTE_ACTION": self._execute_action,
            "LIST_PAGES": self._list_pages,
            "SELECT_PAGE": self._select_page,
            "HUMAN_GATE_BEGIN": self._human_gate_begin,
            "HUMAN_GATE_COMPLETE": self._human_gate_complete,
            "SHUTDOWN": self._shutdown,
        }
        if self.state == "HUMAN_GATE_PENDING" and command not in {
            "STATUS",
            "HUMAN_GATE_COMPLETE",
            "SHUTDOWN",
        }:
            raise GuardPolicyError("only gate status, completion or shutdown is allowed while human gate is pending")
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
            "pageCount": len(self._live_pages()),
            "barrierStatus": self._barrier_status(),
            "evidenceDirectory": str(self.evidence.root),
        }

    def _capture_screenshot(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        value = self._active_page().screenshot()
        if not isinstance(value, bytes):
            raise GuardPolicyError("Playwright screenshot did not return bytes")
        result = self.evidence.write_artifact(payload["artifactId"], "screenshot-png", value)
        return {
            "artifactId": result.artifact_id,
            "filename": result.filename,
            "byteCount": result.byte_count,
        }

    def _require_plan(self) -> ReadOnlyInteractionPlan:
        if self._plan is None:
            raise GuardPolicyError("interaction plan is unavailable")
        return self._plan

    def _register_page(self, page: Any) -> str:
        for identifier, existing in self._pages.items():
            if existing is page:
                return identifier
        identifier = f"page-{new_uuid()}"
        self._pages[identifier] = page
        return identifier

    def _live_pages(self) -> Dict[str, Any]:
        self._pages = {
            identifier: page for identifier, page in self._pages.items() if not page.is_closed()
        }
        return dict(self._pages)

    def _active_page(self) -> Any:
        pages = self._live_pages()
        try:
            return pages[self._active_page_id]
        except KeyError as error:
            raise GuardPolicyError("active page is unavailable") from error

    def _target_locator(self, target_id: str, read_type: str | None = None) -> Any:
        target = self._require_plan().target(target_id, read_type)
        return self._active_page().locator(target["selector"])

    def _navigate(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        action = self._require_plan().action(payload["actionId"], "NAVIGATION")
        page = self._active_page()
        response = page.goto(f"{self._require_plan().target_origin}{action['path']}", wait_until="load")
        return {
            "actionId": action["id"],
            "origin": origin_from_url(page.url) or "non-http-origin",
            "path": sanitized_path(page.url),
            "status": response.status if response is not None else None,
            "ok": response.ok if response is not None else True,
            "activePageId": self._active_page_id,
        }

    def _read_text(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        locator = self._target_locator(payload["targetId"], "TEXT")
        return {"targetId": payload["targetId"], "text": locator.text_content()}

    def _read_attribute(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        target = self._require_plan().target(payload["targetId"], "ATTRIBUTE")
        attribute = payload["attribute"]
        if attribute not in target["attributes"]:
            raise InteractionPlanError("attribute is not allowed for target")
        value = self._active_page().locator(target["selector"]).get_attribute(attribute)
        return {"targetId": payload["targetId"], "attribute": attribute, "value": value}

    def _count_elements(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        locator = self._target_locator(payload["targetId"], "COUNT")
        return {"targetId": payload["targetId"], "count": int(locator.count())}

    def _is_visible(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        locator = self._target_locator(payload["targetId"], "VISIBLE")
        return {"targetId": payload["targetId"], "visible": bool(locator.is_visible())}

    def _set_viewport(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        viewport = self._require_plan().viewport(payload["viewportId"])
        self._active_page().set_viewport_size(viewport)
        return {"viewportId": payload["viewportId"], **viewport}

    def _scroll(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        locator = self._target_locator(payload["targetId"])
        locator.scroll_into_view_if_needed()
        delta = 480 if payload["direction"] == "DOWN" else -480
        self._active_page().mouse.wheel(0, delta)
        return {"targetId": payload["targetId"], "direction": payload["direction"]}

    def _wait_load_state(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self._active_page().wait_for_load_state(payload["state"])
        return {"state": payload["state"]}

    def _element_descriptor(self, locator: Any) -> Dict[str, Any]:
        if locator.count() != 1:
            raise InteractionPlanError("action target must resolve to exactly one element")
        tag = ""
        for candidate in ("a", "button", "div", "form", "input", "textarea", "select", "option"):
            if locator.locator(f"xpath=self::{candidate}").count() == 1:
                tag = candidate
                break
        contenteditable = locator.get_attribute("contenteditable")
        draggable = locator.get_attribute("draggable")
        return {
            "tag": tag,
            "role": locator.get_attribute("role") or "",
            "type": locator.get_attribute("type") or "",
            "contenteditable": contenteditable not in {None, "false"},
            "draggable": draggable == "true",
            "formAncestor": locator.locator("xpath=ancestor::form").count() > 0,
            "accessibleName": locator.get_attribute("aria-label") or locator.text_content() or "",
        }

    def _execute_action(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        action = self._require_plan().action(payload["actionId"])
        if action["type"] == "NAVIGATION":
            raise InteractionPlanError("navigation actions require the NAVIGATE command")
        target = self._require_plan().target(action["targetId"])
        page = self._active_page()
        locator = page.locator(target["selector"])
        validate_element_policy(action, self._element_descriptor(locator))
        if action["type"] == "READONLY_DETAIL" and action["resultKind"] == "popup":
            with page.expect_popup() as popup_info:
                locator.click()
            popup = popup_info.value
            popup.wait_for_load_state("domcontentloaded")
            popup_id = self._register_page(popup)
            popup_origin = origin_from_url(popup.url)
            popup_path = sanitized_path(popup.url)
            if popup_origin != self._require_plan().target_origin or popup_path not in self._require_plan().allowed_paths:
                popup.close()
                raise InteractionPlanError("popup escaped the committed origin/path policy")
            self._active_page_id = popup_id
        elif action["type"] == "FOCUS":
            locator.focus()
        elif action["type"] == "SAFE_KEY":
            locator.focus()
            locator.press(action["key"])
        else:
            locator.click()
        return {
            "actionId": action["id"],
            "actionType": action["type"],
            "activePageId": self._active_page_id,
            "pageCount": len(self._live_pages()),
        }

    def _list_pages(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        pages = []
        for identifier, page in self._live_pages().items():
            pages.append(
                {
                    "pageId": identifier,
                    "origin": origin_from_url(page.url) or "non-http-origin",
                    "path": sanitized_path(page.url),
                    "title": page.title(),
                    "active": identifier == self._active_page_id,
                }
            )
        return {"pages": pages, "activePageId": self._active_page_id}

    def _select_page(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        pages = self._live_pages()
        if payload["pageId"] not in pages:
            raise InteractionPlanError("page ID is not owned by this session")
        self._active_page_id = payload["pageId"]
        pages[self._active_page_id].bring_to_front()
        return {"activePageId": self._active_page_id}

    def _human_gate_begin(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.state not in {"READY", "ACTIVE"}:
            raise GuardPolicyError("human gate cannot begin in the current state")
        self.state = "HUMAN_GATE_PENDING"
        return self._gate_result()

    def _human_gate_complete(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.state != "HUMAN_GATE_PENDING":
            raise GuardPolicyError("human gate is not pending")
        if not all(self._barrier_status().values()):
            raise GuardInitializationError("human gate cannot complete without green barriers")
        self._active_page()
        self.state = "ACTIVE"
        return self._gate_result()

    def _gate_result(self) -> Dict[str, Any]:
        return {
            "state": self.state,
            "brokerPid": os.getpid(),
            "contextEpoch": self.context_epoch,
            "activePageId": self._active_page_id,
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
                except (EOFError, ProtocolError):
                    try:
                        write_frame(
                            connection,
                            self._error_response(
                                {},
                                "INVALID_REQUEST",
                                "malformed protocol frame",
                            ),
                        )
                    except OSError:
                        pass
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
                except (
                    ProtocolError,
                    GuardPolicyError,
                    EvidencePolicyError,
                    InteractionPlanError,
                ) as error:
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
