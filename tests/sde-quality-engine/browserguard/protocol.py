"""Closed, versioned JSON protocol for the Browserguard Unix socket."""

from __future__ import annotations

import hashlib
import json
import socket
import struct
import uuid
from pathlib import Path
from typing import Any, Dict, Mapping

from evidence import ARTIFACT_ID_PATTERN


PROTOCOL_VERSION = "sde-browserguard-broker/v1"
MAX_FRAME_BYTES = 65_536
HERE = Path(__file__).resolve().parent
SCHEMA_PATH = HERE.parent / "contracts" / "sde-browserguard-broker-protocol-v1.schema.json"
REQUEST_FIELDS = frozenset(
    {"protocolVersion", "protocolHash", "sessionId", "commandId", "sequence", "command", "payload"}
)
RESPONSE_FIELDS = frozenset(
    {"protocolVersion", "sessionId", "responseId", "responseTo", "sequence", "ok", "result", "error"}
)
STARTUP_FIELDS = frozenset(
    {"protocolVersion", "protocolHash", "sessionId", "socketPath", "brokerPid", "state"}
)
FOUNDATION_COMMANDS: Mapping[str, frozenset[str]] = {
    "HELLO": frozenset(),
    "STATUS": frozenset(),
    "CAPTURE_SCREENSHOT": frozenset({"artifactId"}),
    "WRITE_REPORT": frozenset({"artifactId"}),
    "SHUTDOWN": frozenset(),
}


class ProtocolError(RuntimeError):
    """Raised for malformed, mismatched or out-of-policy protocol data."""


def protocol_schema() -> Dict[str, Any]:
    value = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ProtocolError("protocol schema must be an object")
    return value


def protocol_hash() -> str:
    canonical = json.dumps(
        protocol_schema(), sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("ascii")
    return hashlib.sha256(canonical).hexdigest()


def _is_uuid4(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        return False
    return parsed.version == 4 and str(parsed) == value


def _validate_artifact_id(value: Any) -> bool:
    import re

    return isinstance(value, str) and re.fullmatch(ARTIFACT_ID_PATTERN, value) is not None


def validate_startup(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict) or set(value) != STARTUP_FIELDS:
        raise ProtocolError("startup metadata fields are invalid")
    if value["protocolVersion"] != PROTOCOL_VERSION or value["protocolHash"] != protocol_hash():
        raise ProtocolError("startup protocol version or hash mismatch")
    if not _is_uuid4(value["sessionId"]):
        raise ProtocolError("startup session ID is invalid")
    if not isinstance(value["socketPath"], str) or not value["socketPath"]:
        raise ProtocolError("startup socket path is invalid")
    if not isinstance(value["brokerPid"], int) or isinstance(value["brokerPid"], bool) or value["brokerPid"] <= 0:
        raise ProtocolError("startup broker PID is invalid")
    if value["state"] != "READY":
        raise ProtocolError("broker did not reach READY")
    return dict(value)


def validate_request(value: Any, *, expected_session_id: str) -> Dict[str, Any]:
    if not isinstance(value, dict) or set(value) != REQUEST_FIELDS:
        raise ProtocolError("request fields are invalid")
    if value["protocolVersion"] != PROTOCOL_VERSION or value["protocolHash"] != protocol_hash():
        raise ProtocolError("protocol version or hash mismatch")
    if value["sessionId"] != expected_session_id or not _is_uuid4(value["sessionId"]):
        raise ProtocolError("session ID is invalid")
    if not _is_uuid4(value["commandId"]):
        raise ProtocolError("command ID is invalid")
    if not isinstance(value["sequence"], int) or isinstance(value["sequence"], bool) or value["sequence"] < 1:
        raise ProtocolError("sequence is invalid")
    command = value["command"]
    if command not in FOUNDATION_COMMANDS:
        raise ProtocolError("command is not allowlisted")
    payload = value["payload"]
    required = FOUNDATION_COMMANDS[command]
    if not isinstance(payload, dict) or set(payload) != required:
        raise ProtocolError("command payload fields are invalid")
    if "artifactId" in required and not _validate_artifact_id(payload["artifactId"]):
        raise ProtocolError("artifact ID is invalid")
    return dict(value)


def validate_response(
    value: Any,
    *,
    expected_session_id: str,
    expected_command_id: str,
    expected_sequence: int,
) -> Dict[str, Any]:
    if not isinstance(value, dict) or set(value) != RESPONSE_FIELDS:
        raise ProtocolError("response fields are invalid")
    if value["protocolVersion"] != PROTOCOL_VERSION or value["sessionId"] != expected_session_id:
        raise ProtocolError("response protocol or session mismatch")
    if not _is_uuid4(value["responseId"]) or value["responseTo"] != expected_command_id:
        raise ProtocolError("response correlation is invalid")
    if value["sequence"] != expected_sequence:
        raise ProtocolError("response sequence is invalid")
    if not isinstance(value["ok"], bool):
        raise ProtocolError("response status is invalid")
    if value["ok"]:
        if not isinstance(value["result"], dict) or value["error"] is not None:
            raise ProtocolError("successful response shape is invalid")
    else:
        error = value["error"]
        if value["result"] is not None or not isinstance(error, dict) or set(error) != {"code", "message"}:
            raise ProtocolError("error response shape is invalid")
        if error["code"] not in {"INVALID_REQUEST", "POLICY_REJECTED", "INTERNAL_ERROR"}:
            raise ProtocolError("error response code is invalid")
        if not isinstance(error["message"], str) or not 1 <= len(error["message"]) <= 300:
            raise ProtocolError("error response message is invalid")
    return dict(value)


def read_frame(connection: socket.socket) -> Dict[str, Any]:
    header = _read_exact(connection, 4)
    length = struct.unpack("!I", header)[0]
    if length < 2 or length > MAX_FRAME_BYTES:
        raise ProtocolError("frame length is outside the protocol limit")
    payload = _read_exact(connection, length)
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("frame is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ProtocolError("frame root must be an object")
    return value


def _read_exact(connection: socket.socket, count: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < count:
        chunk = connection.recv(count - len(chunks))
        if not chunk:
            raise EOFError("protocol connection closed")
        chunks.extend(chunk)
    return bytes(chunks)


def write_frame(connection: socket.socket, value: Mapping[str, Any]) -> None:
    try:
        payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    except (TypeError, ValueError) as error:
        raise ProtocolError("response is not a JSON-only DTO") from error
    if len(payload) > MAX_FRAME_BYTES:
        raise ProtocolError("serialized frame exceeds the protocol limit")
    connection.sendall(struct.pack("!I", len(payload)) + payload)


def new_uuid() -> str:
    return str(uuid.uuid4())
