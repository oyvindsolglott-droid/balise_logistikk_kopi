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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional
from urllib.parse import urlsplit

from playwright.sync_api import BrowserContext, Page, Route, WebSocketRoute, sync_playwright


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
PROTECTED_PAGE_ROUTING_METHODS = frozenset(
    {"route", "unroute", "unroute_all", "route_web_socket", "context"}
)


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
    if require_private_tmp and Path("/private/tmp") not in (resolved, *resolved.parents):
        raise GuardInitializationError("temporary directory must remain under /private/tmp")
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise GuardInitializationError("temporary directory must be a real directory, not a symlink")
    if metadata.st_mode & 0o077:
        raise GuardInitializationError("temporary directory permissions must be owner-only")


def secure_temp_directory(prefix: str) -> Path:
    path = Path(tempfile.mkdtemp(prefix=prefix, dir="/private/tmp"))
    path.chmod(0o700)
    _assert_secure_directory(path, require_private_tmp=True)
    return path


class GuardedPage:
    """Narrow Page proxy that refuses page-local routing overrides."""

    def __init__(self, harness: "ProtectedBrowserHarness", page: Page) -> None:
        object.__setattr__(self, "_GuardedPage__harness", harness)
        object.__setattr__(self, "_GuardedPage__page", page)

    def __getattr__(self, name: str) -> Any:
        if name in PROTECTED_PAGE_ROUTING_METHODS:
            raise GuardPolicyError(f"page-local routing method '{name}' is disabled")
        page = object.__getattribute__(self, "_GuardedPage__page")
        return getattr(page, name)

    def goto(self, url: str, **kwargs: Any) -> Any:
        harness = object.__getattribute__(self, "_GuardedPage__harness")
        harness.assert_ready_for_page_navigation(url)
        page = object.__getattribute__(self, "_GuardedPage__page")
        return page.goto(url, **kwargs)


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
        self._page_ids: "weakref.WeakKeyDictionary[Page, str]" = weakref.WeakKeyDictionary()
        self._page_counter = 0
        self._first_page_seen = False
        self._first_page_before_barriers = False
        self._playwright = None
        self._browser = None
        self._context: Optional[BrowserContext] = None
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

    def _on_context_page(self, page: Page) -> None:
        with self._lock:
            self._first_page_seen = True
            if not (
                self._report["httpBarrierInstalled"]
                and self._report["webSocketBarrierInstalled"]
                and self._report["serviceWorkersBlocked"]
            ):
                self._first_page_before_barriers = True
            self._page_identity(page)

    def _page_identity(self, page: Optional[Page]) -> str:
        if page is None:
            return "context"
        existing = self._page_ids.get(page)
        if existing:
            return existing
        self._page_counter += 1
        identity = f"page-{self._page_counter}"
        self._page_ids[page] = identity
        return identity

    def _request_page(self, route: Route) -> Optional[Page]:
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
        page: Optional[Page],
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

    def _http_route_handler(self, route: Route) -> None:
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

    def _websocket_route_handler(self, route: WebSocketRoute) -> None:
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
            self._playwright = sync_playwright().start()
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
        return GuardedPage(self, self._context.new_page())

    def open_popup(self, opener: GuardedPage, url: str) -> GuardedPage:
        self.assert_ready_for_page_navigation(url)
        raw_opener = object.__getattribute__(opener, "_GuardedPage__page")
        with raw_opener.expect_popup() as popup_info:
            raw_opener.evaluate("target => window.open(target, '_blank')", url)
        return GuardedPage(self, popup_info.value)

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

    def write_report(self, path: Path) -> None:
        target = Path(path)
        if target.parent.resolve(strict=True) != self.evidence_directory.resolve(strict=True):
            raise GuardPolicyError("report must be written directly inside the secured evidence directory")
        if target.exists() and target.is_symlink():
            raise GuardPolicyError("report path must not be a symlink")
        target.write_text(json.dumps(self.report(), indent=2, sort_keys=True) + "\n", encoding="utf-8")

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
