"""Permanent negative tests for the common Browserguard evidence writer."""

from __future__ import annotations

import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

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

    def test_artifact_id_generates_broker_owned_filename(self) -> None:
        with EvidenceWriter(self.root) as writer:
            result = writer.write_artifact("desktop-home", "screenshot-png", b"png")
        self.assertEqual(result.filename, "desktop-home.png")
        self.assertEqual((self.root / result.filename).read_bytes(), b"png")
        self.assertEqual(stat.S_IMODE((self.root / result.filename).stat().st_mode), 0o600)

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
