"""Fail-closed Playwright guard for a protected read-only browser origin.

The component intentionally exposes no production defaults.  A caller must
provide one exact origin and complete a separately controlled authentication
gate later.  This module never serializes browser storage, request bodies,
headers, cookies, tokens, or response data.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import shutil
import stat
import tempfile
import threading
import weakref
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from urllib.parse import urlsplit

from evidence import EvidencePolicyError, EvidenceWriter, _private_temp_parent
from playwright.sync_api import (
    BrowserContext as _BrowserContext,
    Page as _Page,
    Route as _Route,
    WebSocketRoute as _WebSocketRoute,
    sync_playwright as _sync_playwright,
)


__all__ = (
    "GuardInitializationError",
    "GuardPolicyError",
    "GuardedPage",
    "NavigationResult",
    "ProtectedBrowserHarness",
    "ScreenshotResult",
)


SCHEMA_VERSION = "sde-production-readonly-browser-guard/v1"
ALLOWED_HTTP_METHODS = frozenset({"GET", "HEAD"})
MANDATORY_BLOCKED_METHODS = frozenset(
    {"POST", "PUT", "PATCH", "DELETE", "OPTIONS", "XHR POST", "FORM POST", "SENDBEACON"}
)
AUDIT_FIELDS = frozenset(
    {
        "timestamp",
        "method",
        "origin",
        "path",
        "resourceType",
        "allowed",
        "blocked",
        "barrierReason",
        "pageIdentity",
    }
)
PUBLIC_GUARDED_PAGE_API = frozenset(
    {
        "attribute",
        "close",
        "goto",
        "is_visible",
        "locator_count",
        "screenshot",
        "scroll_by",
        "set_viewport",
        "text",
        "wait_until_loaded",
    }
)
PUBLIC_HARNESS_API = frozenset(
    {
        "assert_ready_for_page_navigation",
        "close",
        "complete_local_probes",
        "new_page",
        "open_popup",
        "report",
        "service_worker_count",
        "start",
        "write_report",
    }
)
PUBLIC_HARNESS_ATTRIBUTES = frozenset(
    {"download_directory", "evidence_directory", "headless", "profile_directory", "target_origin"}
)
SAFE_VISIBLE_ATTRIBUTES = frozenset({"alt", "class", "id", "role", "title"})
_GUARDED_PAGE_STATE: "weakref.WeakKeyDictionary[GuardedPage, tuple[ProtectedBrowserHarness, _Page]]" = (
    weakref.WeakKeyDictionary()
)
_GUARDED_PAGE_TOKEN = object()


class GuardInitializationError(RuntimeError):
    """Raised when a mandatory pre-network guard cannot be proven."""


class GuardPolicyError(RuntimeError):
    """Raised when a caller attempts to weaken a context-wide barrier."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _host_for_origin(hostname: str) -> str:
    return f"[{hostname}]" if ":" in hostname else hostname


def normalize_http_origin(value: str) -> str:
    """Return a canonical HTTP(S) origin and reject URL-shaped ambiguity."""

    if not isinstance(value, str) or not value:
        raise GuardInitializationError("target origin must be a non-empty string")
    parsed = urlsplit(value)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise GuardInitializationError("target origin must use http or https")
    if not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise GuardInitializationError("target origin must not contain credentials")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise GuardInitializationError("target origin must not contain path, query, or fragment")
    try:
        port = parsed.port
    except ValueError as error:
        raise GuardInitializationError("target origin contains an invalid port") from error
    scheme = parsed.scheme.lower()
    default_port = 80 if scheme == "http" else 443
    port_suffix = "" if port in {None, default_port} else f":{port}"
    return f"{scheme}://{_host_for_origin(parsed.hostname.lower())}{port_suffix}"


def origin_from_url(value: str) -> Optional[str]:
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            return None
        return normalize_http_origin(
            f"{parsed.scheme.lower()}://{_host_for_origin(parsed.hostname.lower())}"
            f"{f':{parsed.port}' if parsed.port is not None else ''}"
        )
    except (GuardInitializationError, ValueError):
        return None


def sanitized_path(value: str) -> str:
    parsed = urlsplit(value)
    return parsed.path or "/"


def is_protected_websocket_url(value: str, target_origin: str) -> bool:
    try:
        parsed = urlsplit(value)
        target = urlsplit(target_origin)
        expected_scheme = "ws" if target.scheme == "http" else "wss"
        if parsed.scheme.lower() != expected_scheme or not parsed.hostname:
            return False
        actual_port = parsed.port or (80 if parsed.scheme.lower() == "ws" else 443)
        target_port = target.port or (80 if target.scheme == "http" else 443)
        return parsed.hostname.lower() == target.hostname.lower() and actual_port == target_port
    except ValueError:
        return False


def _assert_secure_directory(path: Path, *, require_private_tmp: bool) -> None:
    resolved = path.resolve(strict=True)
    temp_root = _private_temp_parent().resolve(strict=True)
    if require_private_tmp and temp_root not in (resolved, *resolved.parents):
        raise GuardInitializationError("temporary directory must remain under the private temp root")
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise GuardInitializationError("temporary directory must be a real directory, not a symlink")
    if metadata.st_mode & 0o077:
        raise GuardInitializationError("temporary directory permissions must be owner-only")


def secure_temp_directory(prefix: str) -> Path:
    path = Path(tempfile.mkdtemp(prefix=prefix, dir=_private_temp_parent()))
    path.chmod(0o700)
    _assert_secure_directory(path, require_private_tmp=True)
    return path


@dataclass(frozen=True)
class NavigationResult:
    """Sanitized result from a completed navigation."""

    __slots__ = ("origin", "path", "status", "ok")

    origin: str
    path: str
    status: Optional[int]
    ok: bool


@dataclass(frozen=True)
class ScreenshotResult:
    """Metadata for evidence written inside the controlled evidence directory."""

    __slots__ = ("path", "byte_count")

    path: str
    byte_count: int


def _page_state(guarded_page: "GuardedPage") -> tuple["ProtectedBrowserHarness", _Page]:
    try:
        return _GUARDED_PAGE_STATE[guarded_page]
    except (KeyError, TypeError) as error:
        raise GuardPolicyError("guarded page is not owned by this browserguard") from error


def _make_guarded_page(harness: "ProtectedBrowserHarness", page: _Page) -> "GuardedPage":
    guarded_page = GuardedPage(_GUARDED_PAGE_TOKEN)
    _GUARDED_PAGE_STATE[guarded_page] = (harness, page)
    return guarded_page


def _qualification_evaluate(guarded_page: "GuardedPage", expression: str, argument: Any = None) -> Any:
    """Internal local-test seam; deliberately absent from the public facade."""

    _, page = _page_state(guarded_page)
    return deepcopy(page.evaluate(expression, argument))


def _qualification_click(guarded_page: "GuardedPage", selector: str) -> None:
    _, page = _page_state(guarded_page)
    page.click(selector)


def _qualification_wait_for_timeout(guarded_page: "GuardedPage", timeout_ms: int) -> None:
    _, page = _page_state(guarded_page)
    page.wait_for_timeout(timeout_ms)


def _broker_screenshot_bytes(guarded_page: "GuardedPage") -> bytes:
    """Broker-only screenshot seam that never accepts a filesystem path."""

    _, page = _page_state(guarded_page)
    value = page.screenshot()
    if not isinstance(value, bytes):
        raise GuardPolicyError("Playwright screenshot did not return bytes")
    return value


class GuardedPage:
    """Explicit allowlisted facade over an internally owned Playwright Page."""

    __slots__ = ("__weakref__",)

    def __init__(self, token: object) -> None:
        if token is not _GUARDED_PAGE_TOKEN:
            raise GuardPolicyError("GuardedPage instances are created only by ProtectedBrowserHarness")

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        raise GuardPolicyError(f"page operation '{name}' is not in the browserguard public allowlist")

    def goto(
        self,
        url: str,
        *,
        wait_until: str = "load",
        timeout_ms: Optional[int] = None,
    ) -> NavigationResult:
        harness, page = _page_state(self)
        harness.assert_ready_for_page_navigation(url)
        if wait_until not in {"commit", "domcontentloaded", "load", "networkidle"}:
            raise GuardPolicyError("navigation wait condition is not allowlisted")
        kwargs: Dict[str, Any] = {"wait_until": wait_until}
        if timeout_ms is not None:
            if not isinstance(timeout_ms, int) or timeout_ms <= 0:
                raise GuardPolicyError("navigation timeout must be a positive integer")
            kwargs["timeout"] = timeout_ms
        response = page.goto(url, **kwargs)
        final_url = page.url
        return NavigationResult(
            origin=origin_from_url(final_url) or "non-http-origin",
            path=sanitized_path(final_url),
            status=response.status if response is not None else None,
            ok=response.ok if response is not None else True,
        )

    def text(self, selector: str) -> Optional[str]:
        _, page = _page_state(self)
        return page.locator(selector).text_content()

    def attribute(self, selector: str, name: str) -> Optional[str]:
        normalized = name.lower()
        if normalized not in SAFE_VISIBLE_ATTRIBUTES and not normalized.startswith("aria-"):
            raise GuardPolicyError(f"attribute '{name}' is not allowlisted")
        _, page = _page_state(self)
        return page.locator(selector).get_attribute(normalized)

    def locator_count(self, selector: str) -> int:
        _, page = _page_state(self)
        return int(page.locator(selector).count())

    def is_visible(self, selector: str) -> bool:
        _, page = _page_state(self)
        return bool(page.locator(selector).is_visible())

    def set_viewport(self, width: int, height: int) -> None:
        if not all(isinstance(value, int) and 1 <= value <= 10_000 for value in (width, height)):
            raise GuardPolicyError("viewport dimensions must be integers between 1 and 10000")
        _, page = _page_state(self)
        page.set_viewport_size({"width": width, "height": height})

    def scroll_by(self, x: int, y: int) -> None:
        if not all(isinstance(value, int) and abs(value) <= 1_000_000 for value in (x, y)):
            raise GuardPolicyError("scroll offsets must be bounded integers")
        _, page = _page_state(self)
        page.mouse.wheel(x, y)

    def wait_until_loaded(self, state: str = "load", *, timeout_ms: Optional[int] = None) -> None:
        if state not in {"domcontentloaded", "load", "networkidle"}:
            raise GuardPolicyError("load state is not allowlisted")
        kwargs: Dict[str, Any] = {}
        if timeout_ms is not None:
            if not isinstance(timeout_ms, int) or timeout_ms <= 0:
                raise GuardPolicyError("load timeout must be a positive integer")
            kwargs["timeout"] = timeout_ms
        _, page = _page_state(self)
        page.wait_for_load_state(state, **kwargs)

    def screenshot(self, filename: str) -> ScreenshotResult:
        if not isinstance(filename, str) or not filename or Path(filename).name != filename:
            raise GuardPolicyError("screenshot filename must be a plain filename")
        if Path(filename).suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            raise GuardPolicyError("screenshot filename must use png or jpeg")
        harness, page = _page_state(self)
        target = harness._controlled_evidence_path(filename)
        value = page.screenshot()
        if not isinstance(value, bytes):
            raise GuardPolicyError("Playwright screenshot did not return bytes")
        try:
            with EvidenceWriter(harness.evidence_directory) as writer:
                result = writer.write_named(filename, value)
        except EvidencePolicyError as error:
            raise GuardPolicyError(str(error)) from error
        return ScreenshotResult(path=str(target), byte_count=result.byte_count)

    def close(self) -> None:
        _, page = _page_state(self)
        page.close()


class ProtectedBrowserHarness:
    """Create one protected context with barriers installed before any page."""

    def __init__(
        self,
        target_origin: str,
        *,
        headless: bool = True,
        evidence_directory: Optional[Path] = None,
    ) -> None:
        self.target_origin = normalize_http_origin(target_origin)
        self.headless = bool(headless)
        self.profile_directory = secure_temp_directory("sde-qe-browser-profile-")
        self.download_directory = self.profile_directory / "downloads"
        self.download_directory.mkdir(mode=0o700)
        _assert_secure_directory(self.download_directory, require_private_tmp=True)
        if evidence_directory is None:
            self.evidence_directory = secure_temp_directory("sde-qe-browser-evidence-")
            self._owns_evidence_directory = True
        else:
            self.evidence_directory = Path(evidence_directory)
            _assert_secure_directory(self.evidence_directory, require_private_tmp=True)
            self._owns_evidence_directory = False

        self._lock = threading.Lock()
        self._audit_entries: list[Dict[str, Any]] = []
        self._page_ids: "weakref.WeakKeyDictionary[_Page, str]" = weakref.WeakKeyDictionary()
        self._page_counter = 0
        self._first_page_seen = False
        self._first_page_before_barriers = False
        self._playwright = None
        self._browser = None
        self._context: Optional[_BrowserContext] = None
        self._closed = False
        self._sentinel_probe_status = "BLOCKED"
        self._service_worker_probe_status = "BLOCKED"
        self._websocket_probe_status = "BLOCKED"
        self._popup_coverage = False
        self._security_warnings: list[str] = []
        self._blocked_method_labels: set[str] = set()
        self._websockets_blocked = 0
        self._report: Dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "createdAt": utc_now(),
            "targetOrigin": self.target_origin,
            "browserName": "chromium",
            "browserVersion": "",
            "playwrightVersion": importlib.metadata.version("playwright"),
            "serviceWorkersBlocked": False,
            "httpBarrierInstalled": False,
            "webSocketBarrierInstalled": False,
            "barriersInstalledBeforeFirstPage": False,
            "sentinelProbeStatus": "BLOCKED",
            "allowedRequestCount": 0,
            "blockedRequestCount": 0,
            "blockedMethods": [],
            "webSocketsBlocked": 0,
            "popupCoverage": False,
            "securityWarnings": [],
            "overallStatus": "BLOCKED",
            "audit": [],
            "profileDirectoryDeleted": False,
            "browserDisconnected": False,
            "downloadsIsolated": True,
            "serviceWorkerProbeStatus": "BLOCKED",
            "webSocketProbeStatus": "BLOCKED",
        }
        self._reporting_initialized = True

    def __enter__(self) -> "ProtectedBrowserHarness":
        self.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close()

    def _context_options(self) -> Dict[str, Any]:
        return {
            "service_workers": "block",
            "accept_downloads": False,
        }

    def _launch_arguments(self) -> list[str]:
        return [
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-domain-reliability",
            "--disable-sync",
            "--metrics-recording-only",
            "--no-first-run",
        ]

    def _before_barrier_installation(self) -> None:
        """Test seam; production implementation intentionally does nothing."""

    def _is_http_allowed(self, method: str) -> bool:
        return method in ALLOWED_HTTP_METHODS

    def _on_context_page(self, page: _Page) -> None:
        with self._lock:
            self._first_page_seen = True
            if not (
                self._report["httpBarrierInstalled"]
                and self._report["webSocketBarrierInstalled"]
                and self._report["serviceWorkersBlocked"]
            ):
                self._first_page_before_barriers = True
            self._page_identity(page)

    def _page_identity(self, page: Optional[_Page]) -> str:
        if page is None:
            return "context"
        existing = self._page_ids.get(page)
        if existing:
            return existing
        self._page_counter += 1
        identity = f"page-{self._page_counter}"
        self._page_ids[page] = identity
        return identity

    def _request_page(self, route: _Route) -> Optional[_Page]:
        try:
            return route.request.frame.page
        except Exception:
            return None

    def _record_audit(
        self,
        *,
        method: str,
        url: str,
        resource_type: str,
        allowed: bool,
        reason: str,
        page: Optional[_Page],
    ) -> None:
        parsed_origin = origin_from_url(url)
        if parsed_origin is None and method == "WEBSOCKET":
            parsed = urlsplit(url)
            http_scheme = "http" if parsed.scheme.lower() == "ws" else "https"
            parsed_origin = normalize_http_origin(
                f"{http_scheme}://{_host_for_origin(parsed.hostname or '')}"
                f"{f':{parsed.port}' if parsed.port is not None else ''}"
            )
        entry = {
            "timestamp": utc_now(),
            "method": method,
            "origin": parsed_origin or "invalid-origin",
            "path": sanitized_path(url),
            "resourceType": resource_type,
            "allowed": allowed,
            "blocked": not allowed,
            "barrierReason": reason,
            "pageIdentity": self._page_identity(page),
        }
        if set(entry) != AUDIT_FIELDS:
            raise GuardInitializationError("audit entry contained a non-allowlisted field")
        with self._lock:
            self._audit_entries.append(entry)

    def _http_route_handler(self, route: _Route) -> None:
        request = route.request
        request_origin = origin_from_url(request.url)
        if request_origin != self.target_origin:
            route.continue_()
            return
        method = request.method.upper()
        allowed = self._is_http_allowed(method)
        self._record_audit(
            method=method,
            url=request.url,
            resource_type=request.resource_type,
            allowed=allowed,
            reason="read_only_method" if allowed else "non_read_only_method",
            page=self._request_page(route),
        )
        if allowed:
            route.continue_()
        else:
            self._blocked_method_labels.add(method)
            if method == "POST" and request.resource_type == "xhr":
                self._blocked_method_labels.add("XHR POST")
            elif method == "POST" and request.resource_type == "document":
                self._blocked_method_labels.add("FORM POST")
            elif method == "POST" and request.resource_type == "ping":
                self._blocked_method_labels.add("SENDBEACON")
            route.abort("blockedbyclient")

    def _websocket_route_handler(self, route: _WebSocketRoute) -> None:
        self._record_audit(
            method="WEBSOCKET",
            url=route.url,
            resource_type="websocket",
            allowed=False,
            reason="protected_origin_websocket",
            page=None,
        )
        self._websockets_blocked += 1
        # Deliberately do not call connect_to_server().  Playwright keeps the
        # routed socket entirely browser-side, so no protected-origin handshake
        # or message can reach the network.

    def _install_http_barrier(self) -> bool:
        if self._context is None:
            return False
        self._context.route("**/*", self._http_route_handler)
        return True

    def _install_websocket_barrier(self) -> bool:
        if self._context is None or not hasattr(self._context, "route_web_socket"):
            return False
        self._context.route_web_socket(
            lambda url: is_protected_websocket_url(url, self.target_origin),
            self._websocket_route_handler,
        )
        return True

    def start(self) -> None:
        if self._closed:
            raise GuardInitializationError("closed harness cannot be restarted")
        if self._context is not None:
            return
        options = self._context_options()
        if options.get("service_workers") != "block":
            self._security_warnings.append("service_workers_not_blocked")
            self._refresh_report()
            raise GuardInitializationError("service workers must be blocked before context creation")
        if options.get("accept_downloads") is not False:
            self._security_warnings.append("downloads_not_disabled")
            self._refresh_report()
            raise GuardInitializationError("downloads must be disabled")
        try:
            self._playwright = _sync_playwright().start()
            self._browser = self._playwright.chromium.launch(
                headless=self.headless,
                downloads_path=str(self.download_directory),
                args=self._launch_arguments(),
            )
            self._report["browserVersion"] = self._browser.version
            self._context = self._browser.new_context(**options)
            self._context.on("page", self._on_context_page)
            if self._context.pages:
                self._first_page_before_barriers = True
                raise GuardInitializationError("browser context unexpectedly contained a page")
            self._report["serviceWorkersBlocked"] = True
            self._before_barrier_installation()
            self._report["httpBarrierInstalled"] = self._install_http_barrier()
            self._report["webSocketBarrierInstalled"] = self._install_websocket_barrier()
            self._report["barriersInstalledBeforeFirstPage"] = bool(
                self._reporting_initialized
                and self._report["httpBarrierInstalled"]
                and self._report["webSocketBarrierInstalled"]
                and self._report["serviceWorkersBlocked"]
                and not self._first_page_seen
                and not self._first_page_before_barriers
            )
            if not self._report["barriersInstalledBeforeFirstPage"]:
                raise GuardInitializationError("all barriers must be installed before the first page")
        except Exception:
            self._refresh_report()
            raise

    def _assert_barriers_ready(self) -> None:
        self._refresh_report()
        mandatory = (
            self._reporting_initialized,
            self._report["serviceWorkersBlocked"],
            self._report["httpBarrierInstalled"],
            self._report["webSocketBarrierInstalled"],
            self._report["barriersInstalledBeforeFirstPage"],
        )
        if not all(mandatory) or self._first_page_before_barriers:
            raise GuardInitializationError("target page blocked because mandatory barriers are incomplete")

    def assert_ready_for_page_navigation(self, url: str) -> None:
        self._assert_barriers_ready()
        parsed = urlsplit(url)
        if parsed.scheme and parsed.scheme not in {"http", "https", "about", "data"}:
            raise GuardPolicyError("page navigation uses an unsupported scheme")

    def new_page(self) -> GuardedPage:
        self._assert_barriers_ready()
        if self._context is None:
            raise GuardInitializationError("browser context is unavailable")
        return _make_guarded_page(self, self._context.new_page())

    def open_popup(self, opener: GuardedPage, url: str) -> GuardedPage:
        self.assert_ready_for_page_navigation(url)
        owner, raw_opener = _page_state(opener)
        if owner is not self:
            raise GuardPolicyError("popup opener belongs to a different browserguard")
        with raw_opener.expect_popup() as popup_info:
            raw_opener.evaluate("target => window.open(target, '_blank')", url)
        return _make_guarded_page(self, popup_info.value)

    def service_worker_count(self) -> int:
        return len(self._context.service_workers) if self._context is not None else 0

    def complete_local_probes(
        self,
        *,
        sentinel_green: bool,
        service_worker_green: bool,
        websocket_green: bool,
        popup_green: bool,
        security_warnings: Iterable[str] = (),
    ) -> None:
        self._sentinel_probe_status = "GREEN" if sentinel_green else "RED"
        self._service_worker_probe_status = "GREEN" if service_worker_green else "RED"
        self._websocket_probe_status = "GREEN" if websocket_green else "RED"
        self._popup_coverage = bool(popup_green)
        self._security_warnings.extend(str(item) for item in security_warnings if item)
        self._refresh_report()

    def _refresh_report(self) -> None:
        allowed_count = sum(1 for entry in self._audit_entries if entry["allowed"])
        blocked_count = sum(1 for entry in self._audit_entries if entry["blocked"])
        self._report.update(
            {
                "sentinelProbeStatus": self._sentinel_probe_status,
                "allowedRequestCount": allowed_count,
                "blockedRequestCount": blocked_count,
                "blockedMethods": sorted(self._blocked_method_labels),
                "webSocketsBlocked": self._websockets_blocked,
                "popupCoverage": self._popup_coverage,
                "securityWarnings": sorted(set(self._security_warnings)),
                "audit": deepcopy(self._audit_entries),
                "serviceWorkerProbeStatus": self._service_worker_probe_status,
                "webSocketProbeStatus": self._websocket_probe_status,
            }
        )
        barriers = (
            self._reporting_initialized
            and self._report["serviceWorkersBlocked"]
            and self._report["httpBarrierInstalled"]
            and self._report["webSocketBarrierInstalled"]
            and self._report["barriersInstalledBeforeFirstPage"]
            and not self._first_page_before_barriers
        )
        if not barriers:
            status = "BLOCKED"
        elif any(
            item == "RED"
            for item in (
                self._sentinel_probe_status,
                self._service_worker_probe_status,
                self._websocket_probe_status,
            )
        ):
            status = "RED"
        elif self._security_warnings:
            status = "RED"
        elif (
            self._sentinel_probe_status != "GREEN"
            or self._service_worker_probe_status != "GREEN"
            or self._websocket_probe_status != "GREEN"
            or self._websockets_blocked < 1
            or not self._popup_coverage
            or not MANDATORY_BLOCKED_METHODS.issubset(self._blocked_method_labels)
        ):
            status = "PARTIAL"
        else:
            status = "GREEN"
        self._report["overallStatus"] = status

    def report(self) -> Dict[str, Any]:
        self._refresh_report()
        return deepcopy(self._report)

    def _controlled_evidence_path(self, filename: str) -> Path:
        target = self.evidence_directory / filename
        if target.parent.resolve(strict=True) != self.evidence_directory.resolve(strict=True):
            raise GuardPolicyError("evidence must be written directly inside the secured evidence directory")
        try:
            metadata = target.lstat()
        except FileNotFoundError:
            metadata = None
        if metadata is not None and stat.S_ISLNK(metadata.st_mode):
            raise GuardPolicyError("evidence path must not be a symlink")
        return target

    def write_report(self, path: Path) -> None:
        target = Path(path)
        if target.parent.resolve(strict=True) != self.evidence_directory.resolve(strict=True):
            raise GuardPolicyError("report must be written directly inside the secured evidence directory")
        value = (json.dumps(self.report(), indent=2, sort_keys=True) + "\n").encode("utf-8")
        try:
            with EvidenceWriter(self.evidence_directory) as writer:
                writer.write_named(target.name, value)
        except EvidencePolicyError as error:
            raise GuardPolicyError(str(error)) from error

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._context is not None:
            self._context.close()
        if self._browser is not None:
            self._browser.close()
            self._report["browserDisconnected"] = not self._browser.is_connected()
        else:
            self._report["browserDisconnected"] = True
        if self._playwright is not None:
            self._playwright.stop()
        shutil.rmtree(self.profile_directory)
        self._report["profileDirectoryDeleted"] = not self.profile_directory.exists()
        self._refresh_report()


def validate_report_shape(report: Dict[str, Any], schema: Dict[str, Any]) -> list[str]:
    """Minimal dependency-free validation for the committed report schema."""

    errors: list[str] = []
    required = schema.get("required", [])
    for key in required:
        if key not in report:
            errors.append(f"missing required field: {key}")
    declared = set(schema.get("properties", {}))
    unexpected = sorted(set(report) - declared)
    if unexpected:
        errors.append(f"unexpected report fields: {', '.join(unexpected)}")
    if report.get("schemaVersion") != SCHEMA_VERSION:
        errors.append("schemaVersion mismatch")
    allowed_statuses = schema.get("properties", {}).get("overallStatus", {}).get("enum", [])
    if report.get("overallStatus") not in allowed_statuses:
        errors.append("invalid overallStatus")
    for entry in report.get("audit", []):
        if set(entry) != AUDIT_FIELDS:
            errors.append("audit entry contains non-allowlisted fields")
            break
        if "?" in entry.get("path", ""):
            errors.append("audit path contains a query")
            break
    return errors
