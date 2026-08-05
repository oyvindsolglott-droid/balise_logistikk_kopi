"""Foundation contracts for the separate Browserguard broker process."""

from __future__ import annotations

import ast
import json
import os
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
import unittest
from unittest import mock
from pathlib import Path
from typing import Any, Dict


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import client as client_module  # noqa: E402
from client import (  # noqa: E402
    PUBLIC_CLIENT_API,
    BrowserguardClient,
    BrowserguardClientError,
)
from evidence import _private_temp_parent  # noqa: E402
from protocol import (  # noqa: E402
    PROTOCOL_VERSION,
    new_uuid,
    protocol_hash,
    protocol_schema,
    read_frame,
    validate_startup,
    write_frame,
)


def _assert_json_graph(test: unittest.TestCase, value: Any) -> None:
    test.assertTrue(
        value is None or isinstance(value, (str, bool, int, float, list, dict)),
        f"non-JSON type crossed IPC: {type(value)!r}",
    )
    if isinstance(value, list):
        for item in value:
            _assert_json_graph(test, item)
    elif isinstance(value, dict):
        for key, item in value.items():
            test.assertIsInstance(key, str)
            _assert_json_graph(test, item)


class _RawBroker:
    def __init__(self) -> None:
        environment = dict(os.environ)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        self.process = subprocess.Popen(
            [sys.executable, "-B", str(HERE / "broker.py")],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=environment,
            start_new_session=True,
        )
        assert self.process.stdout is not None
        line = self.process.stdout.readline(8193)
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr is not None else ""
            raise RuntimeError(f"raw broker failed to start: {stderr}")
        self.startup = validate_startup(json.loads(line))
        self.connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.connection.settimeout(10)
        self.connection.connect(self.startup["socketPath"])

    def base_request(self, command: str, sequence: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "protocolHash": protocol_hash(),
            "sessionId": self.startup["sessionId"],
            "commandId": new_uuid(),
            "sequence": sequence,
            "command": command,
            "payload": payload,
        }

    def exchange(self, value: Dict[str, Any]) -> Dict[str, Any]:
        write_frame(self.connection, value)
        return read_frame(self.connection)

    def close(self) -> None:
        self.connection.close()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, 15)
            self.process.wait(timeout=5)
        for stream in (self.process.stdout, self.process.stderr):
            if stream is not None and not stream.closed:
                stream.close()


class BrowserguardBrokerFoundationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = BrowserguardClient().start()
        cls.status_value = cls.client.status()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.close()

    def test_barriers_are_green_before_the_first_page(self) -> None:
        status = self.status_value
        self.assertEqual(status["state"], "READY")
        self.assertEqual(status["pageCount"], 1)
        self.assertTrue(all(status["barrierStatus"].values()))

    def test_private_socket_and_session_directory_modes(self) -> None:
        startup = self.client._startup
        self.assertIsNotNone(startup)
        socket_path = Path(startup["socketPath"])
        self.assertEqual(stat.S_IMODE(socket_path.lstat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(socket_path.parent.lstat().st_mode), 0o700)

    def test_protocol_hash_and_version_match(self) -> None:
        startup = self.client._startup
        self.assertEqual(startup["protocolVersion"], PROTOCOL_VERSION)
        self.assertEqual(startup["protocolHash"], protocol_hash())

    def test_every_protocol_object_rejects_additional_properties(self) -> None:
        objects = []

        def collect(value: Any) -> None:
            if isinstance(value, dict):
                if value.get("type") == "object":
                    objects.append(value)
                for item in value.values():
                    collect(item)
            elif isinstance(value, list):
                for item in value:
                    collect(item)

        collect(protocol_schema())
        self.assertTrue(objects)
        self.assertTrue(all(item.get("additionalProperties") is False for item in objects))

    def test_client_public_surface_is_command_specific(self) -> None:
        public = {name for name in dir(self.client) if not name.startswith("_")}
        self.assertEqual(public, PUBLIC_CLIENT_API)
        for forbidden in ("click", "evaluate", "locator", "request", "route", "context"):
            with self.assertRaises(BrowserguardClientError):
                getattr(self.client, forbidden)

    def test_client_module_does_not_import_playwright(self) -> None:
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(HERE)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        probe = subprocess.run(
            [
                sys.executable,
                "-B",
                "-c",
                "import sys,client; print('playwright' in sys.modules)",
            ],
            cwd=HERE,
            env=environment,
            text=True,
            capture_output=True,
            timeout=10,
            check=True,
        )
        self.assertEqual(probe.stdout.strip(), "False")

    def test_only_broker_owned_runtime_module_imports_playwright(self) -> None:
        importers = set()
        for path in HERE.glob("*.py"):
            if path.name.startswith("test_"):
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=path.name)
            modules = []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    modules.extend(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    modules.append(node.module)
            if any(module == "playwright" or module.startswith("playwright.") for module in modules):
                importers.add(path.name)
        self.assertEqual(importers, {"guard.py"})

    def test_documented_and_package_entrypoints_are_broker_only(self) -> None:
        package = json.loads((HERE.parents[2] / "package.json").read_text(encoding="utf-8"))
        scripts = "\n".join(str(value) for value in package.get("scripts", {}).values())
        readme = (HERE.parent / "README.md").read_text(encoding="utf-8")
        self.assertNotIn("browserguard/guard.py", scripts)
        self.assertNotIn("browserguard/qualify.py", scripts)
        self.assertNotIn("python3 tests/sde-quality-engine/browserguard/qualify.py", readme)
        self.assertIn("browserguard/orchestrate.py", scripts)
        self.assertIn("browserguard/orchestrate.py", readme)

    def test_orchestrator_client_observes_a_distinct_broker_process(self) -> None:
        client = BrowserguardClient().start()
        try:
            status = client.status()
            self.assertNotEqual(status["brokerPid"], os.getpid())
            self.assertEqual(status["brokerPid"], client._process.pid)
        finally:
            client.close()

    def test_no_eval_dynamic_import_or_arbitrary_dispatch(self) -> None:
        for name in ("broker.py", "client.py", "protocol.py"):
            tree = ast.parse((HERE / name).read_text(encoding="utf-8"), filename=name)
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                    self.assertNotIn(node.func.id, {"eval", "exec", "__import__"}, name)
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    modules = [alias.name for alias in node.names]
                    if isinstance(node, ast.ImportFrom) and node.module:
                        modules.append(node.module)
                    self.assertFalse(any(item.startswith("importlib") for item in modules), name)

    def test_screenshot_and_report_are_broker_owned_json_dtos(self) -> None:
        screenshot = self.client.capture_screenshot("foundation-screen")
        report = self.client.write_report("foundation-report")
        _assert_json_graph(self, screenshot)
        _assert_json_graph(self, report)
        root = Path(self.status_value["evidenceDirectory"])
        self.assertEqual((root / screenshot["filename"]).stat().st_size, screenshot["byteCount"])
        self.assertEqual((root / report["filename"]).stat().st_size, report["byteCount"])
        self.assertTrue((root / screenshot["filename"]).is_file())
        self.assertTrue((root / report["filename"]).is_file())

    def test_arbitrary_output_path_is_rejected(self) -> None:
        with self.assertRaises(BrowserguardClientError):
            self.client.capture_screenshot("../escape")

    def test_every_response_is_json_only(self) -> None:
        _assert_json_graph(self, self.status_value)

    def test_unknown_extra_and_version_mismatch_fail_closed(self) -> None:
        broker = _RawBroker()
        try:
            unknown = broker.base_request("UNKNOWN", 1, {})
            self.assertFalse(broker.exchange(unknown)["ok"])

            extra = broker.base_request("HELLO", 1, {})
            extra["unexpected"] = True
            self.assertFalse(broker.exchange(extra)["ok"])

            mismatched = broker.base_request("HELLO", 1, {})
            mismatched["protocolHash"] = "0" * 64
            self.assertFalse(broker.exchange(mismatched)["ok"])

            hello = broker.base_request("HELLO", 1, {})
            self.assertTrue(broker.exchange(hello)["ok"])
            shutdown = broker.base_request("SHUTDOWN", 2, {})
            self.assertTrue(broker.exchange(shutdown)["ok"])
        finally:
            broker.close()

    def test_malformed_complete_frames_receive_one_sanitized_terminal_error(self) -> None:
        marker = "payload-must-not-be-reflected"
        payloads = {
            "zero": struct.pack("!I", 0),
            "oversize": struct.pack("!I", 65_537),
            "invalid-utf8": struct.pack("!I", 2) + b"\xff\xff",
            "invalid-json": struct.pack("!I", len(marker)) + marker.encode("ascii"),
            "non-object": struct.pack("!I", 2) + b"[]",
        }
        for label, payload in payloads.items():
            with self.subTest(label=label):
                broker = _RawBroker()
                try:
                    broker.connection.sendall(payload)
                    response = read_frame(broker.connection)
                    self.assertFalse(response["ok"])
                    self.assertEqual(response["error"], {
                        "code": "INVALID_REQUEST",
                        "message": "malformed protocol frame",
                    })
                    self.assertNotIn(marker, json.dumps(response))
                    self.assertEqual(broker.process.wait(timeout=15), 0)
                    stderr = broker.process.stderr.read() if broker.process.stderr is not None else ""
                    self.assertNotIn("Traceback", stderr)
                    self.assertNotIn(marker, stderr)
                finally:
                    broker.close()

    def test_truncated_frame_has_sanitized_terminal_close_contract(self) -> None:
        broker = _RawBroker()
        try:
            broker.connection.sendall(struct.pack("!I", 20) + b"{")
            broker.connection.shutdown(socket.SHUT_WR)
            response = read_frame(broker.connection)
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"]["message"], "malformed protocol frame")
            self.assertEqual(broker.process.wait(timeout=15), 0)
            with self.assertRaises(EOFError):
                read_frame(broker.connection)
        finally:
            broker.close()

    def test_response_identity_correlation_and_session_uniqueness(self) -> None:
        response_id = new_uuid()

        def make_client() -> BrowserguardClient:
            value = BrowserguardClient()
            value._connection = object()  # type: ignore[assignment]
            value._startup = {"sessionId": new_uuid()}
            return value

        def status_result() -> Dict[str, Any]:
            return {
                "state": "READY",
                "brokerPid": 123,
                "contextEpoch": new_uuid(),
                "pageCount": 1,
                "barrierStatus": {
                    "serviceWorkersBlocked": True,
                    "httpBarrierInstalled": True,
                    "webSocketBarrierInstalled": True,
                    "barriersInstalledBeforeFirstPage": True,
                },
                "evidenceDirectory": "/private/tmp/synthetic-evidence",
            }

        def exchange(value: BrowserguardClient, mutate=None, *, calls: int = 1) -> None:
            requests = []

            def capture(_connection, request):
                requests.append(request)

            def respond(_connection):
                request = requests[-1]
                response = {
                    "protocolVersion": PROTOCOL_VERSION,
                    "sessionId": value._startup["sessionId"],
                    "responseId": response_id,
                    "responseTo": request["commandId"],
                    "sequence": request["sequence"],
                    "ok": True,
                    "result": status_result(),
                    "error": None,
                }
                if mutate is not None:
                    mutate(response)
                return response

            with mock.patch.object(client_module, "write_frame", side_effect=capture), mock.patch.object(
                client_module, "read_frame", side_effect=respond
            ):
                for _ in range(calls):
                    value.status()

        first = make_client()
        with self.assertRaises(BrowserguardClientError):
            exchange(first, calls=2)

        exchange(make_client())

        with self.assertRaises(BrowserguardClientError):
            exchange(make_client(), lambda response: response.update(responseTo=new_uuid()))
        with self.assertRaises(BrowserguardClientError):
            exchange(make_client(), lambda response: response.update(sequence=response["sequence"] + 1))

    def test_broker_shutdown_removes_process_socket_profile_and_sentinel(self) -> None:
        client = BrowserguardClient().start()
        startup = dict(client._startup)
        status = client.status()
        socket_path = Path(startup["socketPath"])
        shutdown = client.close()
        self.assertEqual(shutdown["state"], "CLOSED")
        self.assertTrue(shutdown["profileDeleted"])
        self.assertTrue(shutdown["browserDisconnected"])
        self.assertTrue(shutdown["sentinelStopped"])
        self.assertFalse(socket_path.exists())
        self.assertFalse(socket_path.parent.exists())
        self.assertTrue((Path(status["evidenceDirectory"]) / shutdown["reportFilename"]).is_file())
        with self.assertRaises(ProcessLookupError):
            os.kill(startup["brokerPid"], 0)
        self.assertEqual(client.close(), {})

    def test_broker_only_sigint_and_sigterm_are_sanitized_and_cleanup_complete(self) -> None:
        for signum in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signum=signum):
                before = set(_private_temp_parent().glob("sde-qe-browser-profile-*"))
                broker = _RawBroker()
                socket_path = Path(broker.startup["socketPath"])
                created = set(_private_temp_parent().glob("sde-qe-browser-profile-*")) - before
                try:
                    self.assertTrue(broker.exchange(broker.base_request("HELLO", 1, {}))["ok"])
                    os.kill(broker.process.pid, signum)
                    self.assertEqual(broker.process.wait(timeout=15), 128 + signum)
                    stderr = broker.process.stderr.read() if broker.process.stderr is not None else ""
                    self.assertNotIn("Traceback", stderr)
                    self.assertFalse(socket_path.exists())
                    self.assertFalse(socket_path.parent.exists())
                    self.assertTrue(created)
                    self.assertTrue(all(not path.exists() for path in created))
                finally:
                    broker.close()

    def test_process_group_sigterm_leaves_no_profile_socket_or_process_group(self) -> None:
        before = set(_private_temp_parent().glob("sde-qe-browser-profile-*"))
        broker = _RawBroker()
        socket_path = Path(broker.startup["socketPath"])
        created = set(_private_temp_parent().glob("sde-qe-browser-profile-*")) - before
        process_group = broker.process.pid
        try:
            self.assertTrue(broker.exchange(broker.base_request("HELLO", 1, {}))["ok"])
            os.killpg(process_group, signal.SIGTERM)
            self.assertEqual(broker.process.wait(timeout=15), 128 + signal.SIGTERM)
            stderr = broker.process.stderr.read() if broker.process.stderr is not None else ""
            self.assertNotIn("Traceback", stderr)
            self.assertFalse(socket_path.exists())
            self.assertFalse(socket_path.parent.exists())
            self.assertTrue(created)
            self.assertTrue(all(not path.exists() for path in created))
            with self.assertRaises(ProcessLookupError):
                os.killpg(process_group, 0)
        finally:
            broker.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
