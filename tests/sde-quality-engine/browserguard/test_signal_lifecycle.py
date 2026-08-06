"""Permanent subprocess coverage for controlled Browserguard shutdown."""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from typing import Any, Callable


HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[2]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import broker as broker_module  # noqa: E402
import guard as guard_module  # noqa: E402
from client import BrowserguardClient  # noqa: E402
from evidence import EvidenceWriter, _private_temp_parent  # noqa: E402
from protocol import PROTOCOL_VERSION, protocol_hash, read_frame, write_frame  # noqa: E402


_DIAGNOSTIC_MARKERS = (
    "Traceback",
    "Exception ignored",
    "Task was destroyed",
    "Future exception was never retrieved",
    "Unhandled 'error' event",
    "Error: write EPIPE",
)


def _glob_paths(pattern: str) -> set[Path]:
    return set(_private_temp_parent().glob(pattern))


def _baseline() -> dict[str, set[Path]]:
    return {
        "profiles": _glob_paths("sde-qe-browser-profile-*"),
        "ipc": _glob_paths("sde-qe-bg-ipc-*"),
        "evidence": _glob_paths("sde-qe-browser-evidence-*"),
    }


def _changes(before: dict[str, set[Path]]) -> dict[str, set[Path]]:
    return {
        name: _glob_paths(pattern) - before[name]
        for name, pattern in (
            ("profiles", "sde-qe-browser-profile-*"),
            ("ipc", "sde-qe-bg-ipc-*"),
            ("evidence", "sde-qe-browser-evidence-*"),
        )
    }


def _wait_for(
    predicate: Callable[[], Any],
    *,
    timeout_seconds: float = 30,
) -> Any:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("timed out waiting for lifecycle stage")


def _process_table() -> dict[int, tuple[int, str, str]]:
    completed = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,stat=,command="],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    table: dict[int, tuple[int, str, str]] = {}
    for line in completed.stdout.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) >= 3:
            table[int(parts[0])] = (
                int(parts[1]),
                parts[2],
                parts[3] if len(parts) == 4 else "",
            )
    return table


def _descendants(parent: int) -> set[int]:
    table = _process_table()
    found: set[int] = set()
    pending = [parent]
    while pending:
        current = pending.pop()
        children = [pid for pid, value in table.items() if value[0] == current]
        for child in children:
            if child not in found:
                found.add(child)
                pending.append(child)
    return found


def _live_pids(pids: set[int]) -> set[int]:
    table = _process_table()
    return {
        pid
        for pid in pids
        if pid in table and not table[pid][1].startswith("Z")
    }


def _request(
    startup: dict[str, Any],
    sequence: int,
    command: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "protocolHash": protocol_hash(),
        "sessionId": startup["sessionId"],
        "commandId": str(uuid.uuid4()),
        "sequence": sequence,
        "command": command,
        "payload": payload,
    }


def _connect(startup: dict[str, Any]) -> socket.socket:
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(20)
    connection.connect(startup["socketPath"])
    write_frame(connection, _request(startup, 1, "HELLO", {}))
    response = read_frame(connection)
    if not response["ok"]:
        raise AssertionError("broker HELLO failed")
    return connection


def _direct_process(
    *,
    wrapper_mode: str | None = None,
    marker: Path | None = None,
    headed: bool = False,
) -> subprocess.Popen[str]:
    command = [sys.executable, "-B", str(HERE / "broker.py")]
    if wrapper_mode is not None:
        if marker is None:
            raise AssertionError("wrapper marker is required")
        command = [
            sys.executable,
            "-B",
            str(Path(__file__).resolve()),
            "--wrapper",
            wrapper_mode,
            str(marker),
        ]
    return subprocess.Popen(
        command,
        cwd=REPOSITORY,
        env={
            **os.environ,
            "PYTHONDONTWRITEBYTECODE": "1",
            "SDE_QE_BROWSERGUARD_HEADLESS": "0" if headed else "1",
        },
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        start_new_session=True,
    )


def _send_signal(process: subprocess.Popen[str], signum: int) -> None:
    if signum == signal.SIGTERM:
        os.killpg(process.pid, signum)
    else:
        os.kill(process.pid, signum)


def _cleanup_test_paths(before: dict[str, set[Path]]) -> None:
    for paths in _changes(before).values():
        for path in paths:
            if path.exists() or path.is_symlink():
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    path.unlink(missing_ok=True)


class SignalLifecycleTests(unittest.TestCase):
    maxDiff = None

    def _observe(
        self,
        process: subprocess.Popen[str],
        before: dict[str, set[Path]],
        *,
        expected_exit: int,
        socket_path: Path | None,
        known_descendants: set[int],
    ) -> None:
        try:
            exit_code = process.wait(timeout=25)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
            self.fail("controlled shutdown exceeded its bounded timeout")
        time.sleep(0.35)
        stderr = process.stderr.read(8192) if process.stderr is not None else ""
        current = _changes(before)
        temporary_entries = [
            entry
            for evidence in current["evidence"]
            if evidence.exists()
            for entry in evidence.iterdir()
            if entry.name.startswith(".browserguard-")
        ]
        try:
            self.assertEqual(exit_code, expected_exit)
            self.assertFalse(
                [marker for marker in _DIAGNOSTIC_MARKERS if marker in stderr],
                stderr,
            )
            self.assertFalse(
                [path for path in current["profiles"] if path.exists()],
            )
            self.assertFalse(
                [path for path in current["ipc"] if path.exists()],
            )
            self.assertFalse(socket_path is not None and socket_path.exists())
            self.assertFalse(temporary_entries)
            self.assertFalse(_live_pids(known_descendants))
        finally:
            for stream in (process.stdout, process.stderr):
                if stream is not None and not stream.closed:
                    stream.close()
            _cleanup_test_paths(before)

    def _exercise_stage(self, stage: str, signum: int) -> None:
        before = _baseline()
        process: subprocess.Popen[str]
        connection: socket.socket | None = None
        socket_path: Path | None = None
        if stage == "STARTING":
            process = _direct_process()
            _wait_for(lambda: _changes(before)["profiles"])
            ipc = _changes(before)["ipc"]
            socket_path = next(iter(ipc)) / "b.sock" if ipc else None
        elif stage == "EVIDENCE_WRITE":
            marker = Path(
                tempfile.mkstemp(prefix="sde-qe-evidence-stage-", dir=_private_temp_parent())[1]
            )
            marker.unlink()
            process = _direct_process(wrapper_mode="evidence", marker=marker)
            if process.stdout is None:
                self.fail("broker stdout is unavailable")
            startup = json.loads(process.stdout.readline())
            socket_path = Path(startup["socketPath"])
            connection = _connect(startup)
            write_frame(
                connection,
                _request(startup, 2, "WRITE_REPORT", {"artifactId": "signal-stage"}),
            )
            _wait_for(marker.exists)
            marker.unlink(missing_ok=True)
        else:
            client = BrowserguardClient(
                headed=stage in {"HUMAN_GATE_PENDING", "ACTIVE"}
            ).start()
            if client._process is None or client._startup is None:
                self.fail("broker process did not start")
            process = client._process
            connection = client._connection
            socket_path = Path(client._startup["socketPath"])
            if stage == "HUMAN_GATE_PENDING":
                client.begin_human_gate(timeout_seconds=30)
            elif stage == "ACTIVE":
                gate = client.begin_human_gate(timeout_seconds=30)
                client.complete_human_gate(gate["gateId"])
        known_descendants = _descendants(process.pid)
        _send_signal(process, signum)
        if connection is not None:
            connection.close()
        self._observe(
            process,
            before,
            expected_exit=128 + signum,
            socket_path=socket_path,
            known_descendants=known_descendants,
        )

    def test_supported_signals_clean_all_five_lifecycle_stages(self) -> None:
        signals = [signal.SIGTERM, signal.SIGINT]
        if hasattr(signal, "SIGHUP"):
            signals.append(signal.SIGHUP)
        for signum in signals:
            for stage in (
                "STARTING",
                "READY",
                "HUMAN_GATE_PENDING",
                "ACTIVE",
                "EVIDENCE_WRITE",
            ):
                with self.subTest(signal=signal.Signals(signum).name, stage=stage):
                    self._exercise_stage(stage, signum)

    def test_partial_initialization_boundaries_are_cleanup_safe(self) -> None:
        for mode in (
            "before-first-resource",
            "socket-before-browser",
            "browser-before-context",
        ):
            with self.subTest(mode=mode):
                before = _baseline()
                marker = Path(
                    tempfile.mkstemp(prefix="sde-qe-lifecycle-stage-", dir=_private_temp_parent())[1]
                )
                marker.unlink()
                process = _direct_process(wrapper_mode=mode, marker=marker)
                _wait_for(marker.exists)
                known_descendants = _descendants(process.pid)
                _send_signal(process, signal.SIGTERM)
                ipc = _changes(before)["ipc"]
                socket_path = next(iter(ipc)) / "b.sock" if ipc else None
                marker.unlink(missing_ok=True)
                self._observe(
                    process,
                    before,
                    expected_exit=128 + signal.SIGTERM,
                    socket_path=socket_path,
                    known_descendants=known_descendants,
                )

    def test_repeated_and_mixed_signals_are_idempotent_during_cleanup(self) -> None:
        before = _baseline()
        marker = Path(
            tempfile.mkstemp(prefix="sde-qe-cleanup-stage-", dir=_private_temp_parent())[1]
        )
        marker.unlink()
        process = _direct_process(wrapper_mode="cleanup", marker=marker)
        if process.stdout is None:
            self.fail("broker stdout is unavailable")
        startup = json.loads(process.stdout.readline())
        connection = _connect(startup)
        known_descendants = _descendants(process.pid)
        _send_signal(process, signal.SIGTERM)
        _wait_for(marker.exists)
        os.kill(process.pid, signal.SIGINT)
        if hasattr(signal, "SIGHUP"):
            os.kill(process.pid, signal.SIGHUP)
        connection.close()
        marker.unlink(missing_ok=True)
        self._observe(
            process,
            before,
            expected_exit=128 + signal.SIGTERM,
            socket_path=Path(startup["socketPath"]),
            known_descendants=known_descendants,
        )

    def test_shutdown_command_and_signal_share_cleanup_coordinator(self) -> None:
        before = _baseline()
        marker = Path(
            tempfile.mkstemp(prefix="sde-qe-command-stage-", dir=_private_temp_parent())[1]
        )
        marker.unlink()
        process = _direct_process(wrapper_mode="cleanup", marker=marker)
        if process.stdout is None:
            self.fail("broker stdout is unavailable")
        startup = json.loads(process.stdout.readline())
        connection = _connect(startup)
        known_descendants = _descendants(process.pid)
        response: list[dict[str, Any]] = []

        def shutdown() -> None:
            write_frame(connection, _request(startup, 2, "SHUTDOWN", {}))
            response.append(read_frame(connection))

        thread = threading.Thread(target=shutdown)
        thread.start()
        _wait_for(marker.exists)
        os.kill(process.pid, signal.SIGHUP if hasattr(signal, "SIGHUP") else signal.SIGINT)
        thread.join(timeout=20)
        connection.close()
        marker.unlink(missing_ok=True)
        self.assertFalse(thread.is_alive())
        self.assertTrue(response and response[0]["ok"])
        self._observe(
            process,
            before,
            expected_exit=0,
            socket_path=Path(startup["socketPath"]),
            known_descendants=known_descendants,
        )

    def test_disconnect_and_signal_share_cleanup_coordinator(self) -> None:
        before = _baseline()
        marker = Path(
            tempfile.mkstemp(prefix="sde-qe-disconnect-stage-", dir=_private_temp_parent())[1]
        )
        marker.unlink()
        process = _direct_process(wrapper_mode="cleanup", marker=marker)
        if process.stdout is None:
            self.fail("broker stdout is unavailable")
        startup = json.loads(process.stdout.readline())
        connection = _connect(startup)
        known_descendants = _descendants(process.pid)
        connection.close()
        _wait_for(marker.exists)
        os.kill(process.pid, signal.SIGHUP if hasattr(signal, "SIGHUP") else signal.SIGINT)
        marker.unlink(missing_ok=True)
        self._observe(
            process,
            before,
            expected_exit=0,
            socket_path=Path(startup["socketPath"]),
            known_descendants=known_descendants,
        )

    def test_closing_rejects_commands_and_finalize_is_idempotent(self) -> None:
        coordinator = broker_module.ShutdownCoordinator()
        broker = broker_module.BrowserguardBroker(coordinator)
        coordinator.request("TEST")
        with self.assertRaises(guard_module.GuardPolicyError):
            broker._dispatch({"command": "STATUS", "payload": {}})
        coordinator.finalize()
        coordinator.finalize()
        broker.close()
        self.assertEqual(broker.state, "CLOSED")

    def test_baseexception_cleanup_mutant_is_killed(self) -> None:
        class Context:
            def close(self) -> None:
                raise KeyboardInterrupt("synthetic BaseException cleanup failure")

        class Browser:
            closed = False

            def close(self) -> None:
                self.closed = True

            def is_connected(self) -> bool:
                return not self.closed

        class Playwright:
            stopped = False

            def stop(self) -> None:
                self.stopped = True

        harness = guard_module.ProtectedBrowserHarness("http://127.0.0.1:1")
        evidence = harness.evidence_directory
        browser = Browser()
        playwright = Playwright()
        harness._context = Context()
        harness._browser = browser
        harness._playwright = playwright
        try:
            harness.close()
            harness.close()
            self.assertTrue(browser.closed)
            self.assertTrue(playwright.stopped)
            self.assertFalse(harness.profile_directory.exists())
        finally:
            shutil.rmtree(evidence, ignore_errors=True)

    def test_sigkill_is_explicitly_excluded(self) -> None:
        readme = (HERE.parent / "README.md").read_text(encoding="utf-8")
        self.assertIn("SIGKILL omfattes uttrykkelig ikke", readme)


def _wrapper_main(mode: str, marker: Path) -> int:
    def pause() -> None:
        marker.write_text(mode + "\n", encoding="ascii")
        time.sleep(2)

    if mode == "before-first-resource":
        broker_module._before_first_resource = pause
    elif mode == "socket-before-browser":
        original_start = broker_module.SentinelServer.start

        def sentinel_start(instance: Any) -> Any:
            pause()
            return original_start(instance)

        broker_module.SentinelServer.start = sentinel_start
    elif mode == "browser-before-context":
        guard_module.ProtectedBrowserHarness._before_context_creation = lambda self: pause()
    elif mode == "evidence":
        original_write_all = EvidenceWriter._write_all

        def evidence_write(
            instance: EvidenceWriter,
            descriptor: int,
            value: bytes,
        ) -> None:
            pause()
            original_write_all(instance, descriptor, value)

        EvidenceWriter._write_all = evidence_write
    elif mode == "cleanup":
        original_close = guard_module.ProtectedBrowserHarness.close

        def cleanup(instance: guard_module.ProtectedBrowserHarness) -> None:
            pause()
            original_close(instance)

        guard_module.ProtectedBrowserHarness.close = cleanup
    else:
        raise AssertionError("unknown lifecycle wrapper mode")
    return broker_module.main()


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--wrapper":
        raise SystemExit(_wrapper_main(sys.argv[2], Path(sys.argv[3])))
    unittest.main(verbosity=2)
