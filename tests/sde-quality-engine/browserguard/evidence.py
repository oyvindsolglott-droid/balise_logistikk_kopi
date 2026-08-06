"""Race- and symlink-safe evidence writing inside one owned directory."""

from __future__ import annotations

import errno
import os
import secrets
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


ARTIFACT_ID_PATTERN = r"^[a-z][a-z0-9-]{0,63}$"
_ARTIFACT_SUFFIXES = {
    "json": ".json",
    "manifest": ".txt",
    "screenshot-jpeg": ".jpg",
    "screenshot-png": ".png",
}
_TEMP_CREATE_ATTEMPTS = 8


class EvidencePolicyError(RuntimeError):
    """Raised when an evidence entry cannot be written safely."""


@dataclass(frozen=True)
class EvidenceResult:
    artifact_id: str
    filename: str
    byte_count: int


@dataclass(frozen=True)
class _EntryIdentity:
    device: int
    inode: int
    mode: int


def _private_temp_parent() -> Path:
    preferred = Path("/private/tmp")
    return preferred if preferred.is_dir() else Path(tempfile.gettempdir())


def _assert_plain_filename(filename: str) -> None:
    if not isinstance(filename, str) or not filename or Path(filename).name != filename:
        raise EvidencePolicyError("evidence filename must be one plain path component")
    if filename in {".", ".."} or "\x00" in filename:
        raise EvidencePolicyError("evidence filename is invalid")


def _artifact_filename(artifact_id: str, artifact_type: str) -> str:
    import re

    if not isinstance(artifact_id, str) or re.fullmatch(ARTIFACT_ID_PATTERN, artifact_id) is None:
        raise EvidencePolicyError("artifact ID is not allowlisted")
    try:
        suffix = _ARTIFACT_SUFFIXES[artifact_type]
    except KeyError as error:
        raise EvidencePolicyError("artifact type is not allowlisted") from error
    return f"{artifact_id}{suffix}"


class EvidenceWriter:
    """Write entries relative to a verified directory descriptor.

    The destination name is never opened for writing. Bytes go to an
    exclusively-created sibling and are atomically installed with renameat.
    """

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        metadata = self.root.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise EvidencePolicyError("evidence root must be a real directory")
        if metadata.st_uid != os.getuid():
            raise EvidencePolicyError("evidence root must be owned by the broker user")
        if stat.S_IMODE(metadata.st_mode) != 0o700:
            raise EvidencePolicyError("evidence root mode must be 0700")
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        try:
            self._root_fd = os.open(self.root, flags)
        except OSError as error:
            raise EvidencePolicyError("evidence root could not be opened safely") from error
        opened = os.fstat(self._root_fd)
        if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) != (
            metadata.st_dev,
            metadata.st_ino,
        ):
            os.close(self._root_fd)
            raise EvidencePolicyError("evidence root changed while it was opened")
        self._closed = False

    @classmethod
    def create(cls, prefix: str = "sde-qe-browser-evidence-") -> "EvidenceWriter":
        parent = _private_temp_parent()
        root = Path(tempfile.mkdtemp(prefix=prefix, dir=parent))
        root.chmod(0o700)
        return cls(root)

    def __enter__(self) -> "EvidenceWriter":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()

    def close(self) -> None:
        if not self._closed:
            os.close(self._root_fd)
            self._closed = True

    def _ensure_open(self) -> None:
        if self._closed:
            raise EvidencePolicyError("evidence writer is closed")

    def _entry_identity(self, filename: str) -> Optional[_EntryIdentity]:
        try:
            metadata = os.stat(filename, dir_fd=self._root_fd, follow_symlinks=False)
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(metadata.st_mode):
            raise EvidencePolicyError("evidence target must not be a symlink")
        if not stat.S_ISREG(metadata.st_mode):
            raise EvidencePolicyError("evidence target must be absent or a regular file")
        return _EntryIdentity(metadata.st_dev, metadata.st_ino, metadata.st_mode)

    def _before_revalidate(self, filename: str) -> None:
        """Test seam for a deterministic destination-entry race."""

    def _before_cleanup(self, filename: str) -> None:
        """Test seam for a deterministic temporary-entry replacement race."""

    def _write_all(self, descriptor: int, value: bytes) -> None:
        remaining = memoryview(value)
        while remaining:
            written = os.write(descriptor, remaining)
            if written <= 0:
                raise OSError(errno.EIO, "short evidence write")
            remaining = remaining[written:]

    def write_named(self, filename: str, value: bytes) -> EvidenceResult:
        self._ensure_open()
        _assert_plain_filename(filename)
        if not isinstance(value, bytes):
            raise EvidencePolicyError("evidence value must be bytes")
        baseline = self._entry_identity(filename)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        temporary_name: Optional[str] = None
        temporary_identity: Optional[_EntryIdentity] = None
        descriptor: Optional[int] = None
        installed = False
        try:
            for _ in range(_TEMP_CREATE_ATTEMPTS):
                candidate_name = f".browserguard-{secrets.token_hex(16)}.tmp"
                try:
                    descriptor = os.open(candidate_name, flags, 0o600, dir_fd=self._root_fd)
                except OSError as error:
                    if error.errno == errno.EEXIST:
                        continue
                    raise
                temporary_name = candidate_name
                break
            if descriptor is None or temporary_name is None:
                raise EvidencePolicyError(
                    "temporary evidence entry could not be created safely"
                ) from None
            created = os.fstat(descriptor)
            temporary_identity = _EntryIdentity(
                created.st_dev,
                created.st_ino,
                created.st_mode,
            )
            if not stat.S_ISREG(created.st_mode) or created.st_nlink != 1:
                raise EvidencePolicyError("temporary evidence entry is not a private regular file")
            self._write_all(descriptor, value)
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = None

            self._before_revalidate(filename)
            current = self._entry_identity(filename)
            if current != baseline:
                raise EvidencePolicyError("evidence target changed during write")

            os.replace(
                temporary_name,
                filename,
                src_dir_fd=self._root_fd,
                dst_dir_fd=self._root_fd,
            )
            installed = True
            os.fsync(self._root_fd)
            return EvidenceResult(
                artifact_id=filename.rsplit(".", 1)[0],
                filename=filename,
                byte_count=len(value),
            )
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if temporary_name is not None and temporary_identity is not None and not installed:
                self._before_cleanup(temporary_name)
                try:
                    current = os.stat(
                        temporary_name,
                        dir_fd=self._root_fd,
                        follow_symlinks=False,
                    )
                except FileNotFoundError:
                    current = None
                if (
                    current is not None
                    and stat.S_ISREG(current.st_mode)
                    and _EntryIdentity(current.st_dev, current.st_ino, current.st_mode)
                    == temporary_identity
                ):
                    os.unlink(temporary_name, dir_fd=self._root_fd)

    def write_artifact(self, artifact_id: str, artifact_type: str, value: bytes) -> EvidenceResult:
        return self.write_named(_artifact_filename(artifact_id, artifact_type), value)
