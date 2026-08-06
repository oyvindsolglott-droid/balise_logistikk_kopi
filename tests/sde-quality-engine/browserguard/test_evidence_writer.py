"""Permanent negative tests for the common Browserguard evidence writer."""

from __future__ import annotations

import os
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import evidence as evidence_module  # noqa: E402
from evidence import EvidencePolicyError, EvidenceWriter, _private_temp_parent  # noqa: E402


class _BeforeCheckRaceWriter(EvidenceWriter):
    def __init__(self, root: Path, outside: Path) -> None:
        super().__init__(root)
        self.outside = outside

    def _before_revalidate(self, filename: str) -> None:
        os.symlink(self.outside, filename, dir_fd=self._root_fd)


class _AfterCheckRaceWriter(EvidenceWriter):
    def __init__(self, root: Path, outside: Path) -> None:
        super().__init__(root)
        self.outside = outside
        self.calls = 0

    def _entry_identity(self, filename: str):
        value = super()._entry_identity(filename)
        self.calls += 1
        if self.calls == 2:
            os.symlink(self.outside, filename, dir_fd=self._root_fd)
        return value


class _PartialWriteWriter(EvidenceWriter):
    def _write_all(self, descriptor: int, value: bytes) -> None:
        os.write(descriptor, value[:2])
        raise OSError("synthetic partial write")


class _InterruptWriteWriter(EvidenceWriter):
    def _write_all(self, descriptor: int, value: bytes) -> None:
        os.write(descriptor, value[:2])
        raise KeyboardInterrupt("synthetic controlled interruption")


class _CleanupReplacementWriter(EvidenceWriter):
    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.replacement_name = ""

    def _write_all(self, descriptor: int, value: bytes) -> None:
        os.write(descriptor, value[:2])
        raise OSError("synthetic failure before cleanup")

    def _before_cleanup(self, filename: str) -> None:
        os.unlink(filename, dir_fd=self._root_fd)
        descriptor = os.open(
            filename,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
            dir_fd=self._root_fd,
        )
        try:
            os.write(descriptor, b"foreign replacement")
        finally:
            os.close(descriptor)
        self.replacement_name = filename


class EvidenceWriterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="sde-qe-evidence-test-", dir=_private_temp_parent()))
        self.root.chmod(0o700)
        self.outside_root = Path(tempfile.mkdtemp(prefix="sde-qe-evidence-outside-", dir=_private_temp_parent()))
        self.outside_root.chmod(0o700)
        self.outside = self.outside_root / "outside.bin"
        self.outside.write_bytes(b"outside")

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.outside_root, ignore_errors=True)

    def _temporary_entries(self) -> list[Path]:
        return list(self.root.glob(".browserguard-*.tmp"))

    def _entry_snapshot(self, path: Path) -> tuple[object, ...]:
        metadata = path.lstat()
        if stat.S_ISREG(metadata.st_mode):
            payload: object = path.read_bytes()
        elif stat.S_ISLNK(metadata.st_mode):
            payload = os.readlink(path)
        else:
            payload = None
        return (
            metadata.st_dev,
            metadata.st_ino,
            metadata.st_mode,
            metadata.st_nlink,
            payload,
        )

    def test_artifact_id_generates_broker_owned_filename(self) -> None:
        with EvidenceWriter(self.root) as writer:
            result = writer.write_artifact("desktop-home", "screenshot-png", b"png")
        self.assertEqual(result.filename, "desktop-home.png")
        self.assertEqual((self.root / result.filename).read_bytes(), b"png")
        self.assertEqual(stat.S_IMODE((self.root / result.filename).stat().st_mode), 0o600)

    def test_screenshot_report_and_manifest_share_evidence_writer(self) -> None:
        broker_source = (HERE / "broker.py").read_text(encoding="utf-8")
        guard_source = (HERE / "guard.py").read_text(encoding="utf-8")
        qualify_source = (HERE / "qualify.py").read_text(encoding="utf-8")
        self.assertGreaterEqual(broker_source.count("self.evidence.write_artifact("), 3)
        self.assertIn("writer.write_named(target.name, value)", guard_source)
        self.assertIn('writer.write_named("SHA256SUMS"', qualify_source)

    def test_arbitrary_artifact_paths_are_rejected(self) -> None:
        with EvidenceWriter(self.root) as writer:
            for value in ("../escape", "/absolute", "nested/name", "A", "a.png"):
                with self.subTest(value=value), self.assertRaises(EvidencePolicyError):
                    writer.write_artifact(value, "json", b"{}")

    def test_existing_symlink_is_rejected_without_touching_target(self) -> None:
        (self.root / "report.json").symlink_to(self.outside)
        with EvidenceWriter(self.root) as writer, self.assertRaises(EvidencePolicyError):
            writer.write_named("report.json", b"changed")
        self.assertEqual(self.outside.read_bytes(), b"outside")
        self.assertTrue((self.root / "report.json").is_symlink())

    def test_dangling_symlink_is_rejected(self) -> None:
        dangling = self.outside_root / "missing.bin"
        (self.root / "report.json").symlink_to(dangling)
        with EvidenceWriter(self.root) as writer, self.assertRaises(EvidencePolicyError):
            writer.write_named("report.json", b"changed")
        self.assertTrue((self.root / "report.json").is_symlink())

    def test_symlink_root_is_rejected(self) -> None:
        link = self.outside_root / "root-link"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(EvidencePolicyError):
            EvidenceWriter(link)

    def test_directory_and_fifo_targets_are_rejected(self) -> None:
        (self.root / "directory.json").mkdir()
        os.mkfifo(self.root / "fifo.json", 0o600)
        with EvidenceWriter(self.root) as writer:
            for name in ("directory.json", "fifo.json"):
                with self.subTest(name=name), self.assertRaises(EvidencePolicyError):
                    writer.write_named(name, b"changed")

    def test_race_before_revalidation_is_rejected_and_cleans_temp(self) -> None:
        with _BeforeCheckRaceWriter(self.root, self.outside) as writer:
            with self.assertRaises(EvidencePolicyError):
                writer.write_named("race.json", b"changed")
        self.assertEqual(self.outside.read_bytes(), b"outside")
        self.assertTrue((self.root / "race.json").is_symlink())
        self.assertEqual(self._temporary_entries(), [])

    def test_race_after_revalidation_replaces_only_target_entry(self) -> None:
        with _AfterCheckRaceWriter(self.root, self.outside) as writer:
            writer.write_named("race.json", b"safe")
        self.assertEqual(self.outside.read_bytes(), b"outside")
        self.assertFalse((self.root / "race.json").is_symlink())
        self.assertEqual((self.root / "race.json").read_bytes(), b"safe")
        self.assertEqual(self._temporary_entries(), [])

    def test_partial_write_leaves_existing_file_unchanged_and_no_temp(self) -> None:
        target = self.root / "report.json"
        target.write_bytes(b"complete-old")
        target.chmod(0o600)
        with _PartialWriteWriter(self.root) as writer:
            with self.assertRaises(OSError):
                writer.write_named("report.json", b"new-value")
        self.assertEqual(target.read_bytes(), b"complete-old")
        self.assertEqual(self._temporary_entries(), [])

    def test_regular_target_is_atomically_replaced(self) -> None:
        target = self.root / "report.json"
        target.write_bytes(b"old")
        target.chmod(0o600)
        old_inode = target.stat().st_ino
        with EvidenceWriter(self.root) as writer:
            writer.write_named("report.json", b"new")
        self.assertEqual(target.read_bytes(), b"new")
        self.assertNotEqual(target.stat().st_ino, old_inode)

    def test_all_foreign_temp_collision_types_survive_retry_unchanged(self) -> None:
        creators = {
            "regular": lambda path: path.write_bytes(b"foreign"),
            "symlink": lambda path: path.symlink_to(self.outside),
            "dangling-symlink": lambda path: path.symlink_to(self.outside_root / "missing"),
            "directory": lambda path: path.mkdir(mode=0o700),
            "fifo": lambda path: os.mkfifo(path, 0o600),
        }
        all_collisions: set[Path] = set()
        for index, (label, create) in enumerate(creators.items(), start=1):
            with self.subTest(label=label):
                token = f"{index:032x}"
                fresh = f"{index + 100:032x}"
                collision = self.root / f".browserguard-{token}.tmp"
                target = self.root / f"report-{index}.json"
                create(collision)
                all_collisions.add(collision)
                before = self._entry_snapshot(collision)
                with mock.patch.object(
                    evidence_module.secrets,
                    "token_hex",
                    side_effect=[token, fresh],
                ) as token_hex:
                    with EvidenceWriter(self.root) as writer:
                        writer.write_named(target.name, b"new")
                self.assertEqual(token_hex.call_count, 2)
                self.assertEqual(self._entry_snapshot(collision), before)
                self.assertEqual(target.read_bytes(), b"new")
                self.assertEqual(
                    set(self._temporary_entries()),
                    all_collisions,
                )

    def test_multiple_sequential_collisions_succeed_on_later_retry(self) -> None:
        collision_tokens = [f"{index:032x}" for index in range(201, 205)]
        fresh = f"{299:032x}"
        collisions = []
        for index, token in enumerate(collision_tokens):
            collision = self.root / f".browserguard-{token}.tmp"
            collision.write_bytes(f"foreign-{index}".encode("ascii"))
            collisions.append((collision, self._entry_snapshot(collision)))
        with mock.patch.object(
            evidence_module.secrets,
            "token_hex",
            side_effect=[*collision_tokens, fresh],
        ) as token_hex:
            with EvidenceWriter(self.root) as writer:
                writer.write_named("report.json", b"complete")
        self.assertEqual(token_hex.call_count, 5)
        self.assertEqual((self.root / "report.json").read_bytes(), b"complete")
        for collision, before in collisions:
            self.assertEqual(self._entry_snapshot(collision), before)

    def test_exhausted_retry_is_sanitized_fail_closed(self) -> None:
        tokens = [f"{index:032x}" for index in range(301, 309)]
        collisions = []
        for index, token in enumerate(tokens):
            collision = self.root / f".browserguard-{token}.tmp"
            collision.write_bytes(f"foreign-{index}".encode("ascii"))
            collisions.append((collision, self._entry_snapshot(collision)))
        with mock.patch.object(
            evidence_module.secrets,
            "token_hex",
            side_effect=tokens,
        ) as token_hex:
            with EvidenceWriter(self.root) as writer, self.assertRaises(
                EvidencePolicyError
            ) as captured:
                writer.write_named("report.json", b"new")
        self.assertEqual(token_hex.call_count, 8)
        self.assertEqual(
            str(captured.exception),
            "temporary evidence entry could not be created safely",
        )
        self.assertNotIn(tokens[0], str(captured.exception))
        self.assertFalse((self.root / "report.json").exists())
        for collision, before in collisions:
            self.assertEqual(self._entry_snapshot(collision), before)

    def test_file_fsync_failure_cleans_only_owned_temp(self) -> None:
        real_fsync = os.fsync
        with EvidenceWriter(self.root) as writer:
            def fail_file_fsync(descriptor: int) -> None:
                if descriptor != writer._root_fd:
                    raise OSError("synthetic file fsync failure")
                real_fsync(descriptor)

            with mock.patch.object(
                evidence_module.os,
                "fsync",
                side_effect=fail_file_fsync,
            ), self.assertRaises(OSError):
                writer.write_named("report.json", b"complete")
        self.assertFalse((self.root / "report.json").exists())
        self.assertEqual(self._temporary_entries(), [])

    def test_replace_failure_cleans_only_owned_temp(self) -> None:
        with EvidenceWriter(self.root) as writer, mock.patch.object(
            evidence_module.os,
            "replace",
            side_effect=OSError("synthetic replace failure"),
        ), self.assertRaises(OSError):
            writer.write_named("report.json", b"complete")
        self.assertFalse((self.root / "report.json").exists())
        self.assertEqual(self._temporary_entries(), [])

    def test_directory_fsync_failure_keeps_complete_installed_target(self) -> None:
        real_fsync = os.fsync
        with EvidenceWriter(self.root) as writer:
            def fail_directory_fsync(descriptor: int) -> None:
                if descriptor == writer._root_fd:
                    raise OSError("synthetic directory fsync failure")
                real_fsync(descriptor)

            with mock.patch.object(
                evidence_module.os,
                "fsync",
                side_effect=fail_directory_fsync,
            ), self.assertRaises(OSError):
                writer.write_named("report.json", b"complete")
        self.assertEqual((self.root / "report.json").read_bytes(), b"complete")
        self.assertEqual(self._temporary_entries(), [])

    def test_controlled_interruption_cleans_owned_temp(self) -> None:
        with _InterruptWriteWriter(self.root) as writer, self.assertRaises(
            KeyboardInterrupt
        ):
            writer.write_named("report.json", b"complete")
        self.assertFalse((self.root / "report.json").exists())
        self.assertEqual(self._temporary_entries(), [])

    def test_replaced_owned_temp_is_not_unlinked_during_cleanup(self) -> None:
        with _CleanupReplacementWriter(self.root) as writer, self.assertRaises(
            OSError
        ):
            writer.write_named("report.json", b"complete")
        replacement = self.root / writer.replacement_name
        self.assertEqual(replacement.read_bytes(), b"foreign replacement")
        self.assertFalse((self.root / "report.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
