"""Foundation contracts for the separate Browserguard broker process."""

from __future__ import annotations

import ast
import json
import os
import socket
import stat
import subprocess
import sys
import time
import unittest
from pathlib import Path
from typing import Any, Dict


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from client import (  # noqa: E402
    PUBLIC_CLIENT_API,
    BrowserguardClient,
    BrowserguardClientError,
)
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
