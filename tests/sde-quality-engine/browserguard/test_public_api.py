"""Structural contract for the browserguard public facade."""

from __future__ import annotations

import dataclasses
import shutil
import sys
import unittest
from pathlib import Path
from typing import Any, Optional, Set

from playwright.sync_api import (
    APIRequestContext,
    Browser,
    BrowserContext,
    Frame,
    Page,
    Request,
    Response,
    WebSocketRoute,
)


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import guard as guard_module  # noqa: E402
from guard import (  # noqa: E402
    PUBLIC_GUARDED_PAGE_API,
    PUBLIC_HARNESS_API,
    PUBLIC_HARNESS_ATTRIBUTES,
    GuardPolicyError,
    GuardedPage,
    NavigationResult,
    ProtectedBrowserHarness,
    ScreenshotResult,
    _make_guarded_page,
    secure_temp_directory,
)


FORBIDDEN_PLAYWRIGHT_TYPES = (
    Browser,
    BrowserContext,
    Page,
    Frame,
    APIRequestContext,
    WebSocketRoute,
    Request,
    Response,
)


class _FakeResponse:
    status = 204
    ok = True


class _FakeLocator:
    def text_content(self) -> str:
        return "visible text"

    def get_attribute(self, name: str) -> str:
        return f"visible-{name}"

    def count(self) -> int:
        return 2

    def is_visible(self) -> bool:
        return True


class _FakeMouse:
    def wheel(self, x: int, y: int) -> None:
        self.last_scroll = (x, y)


class _FakePage:
    def __init__(self) -> None:
        self.url = "about:blank"
        self.mouse = _FakeMouse()
        self.closed = False

    def goto(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.url = url
        return _FakeResponse()

    def locator(self, selector: str) -> _FakeLocator:
        return _FakeLocator()

    def set_viewport_size(self, viewport: dict[str, int]) -> None:
        self.viewport = dict(viewport)

    def wait_for_load_state(self, state: str, **kwargs: Any) -> None:
        self.load_state = state

    def screenshot(self, *, path: str) -> None:
        Path(path).write_bytes(b"synthetic screenshot")

    def close(self) -> None:
        self.closed = True


class _FakeHarness:
    def __init__(self, evidence_directory: Path) -> None:
        self.evidence_directory = evidence_directory

    def assert_ready_for_page_navigation(self, url: str) -> None:
        return None

    def _controlled_evidence_path(self, filename: str) -> Path:
        return self.evidence_directory / filename


def _assert_no_forbidden_graph(
    test: unittest.TestCase, value: Any, seen: Optional[Set[int]] = None
) -> None:
    if seen is None:
        seen = set()
    test.assertNotIsInstance(value, FORBIDDEN_PLAYWRIGHT_TYPES)
    if value is None or isinstance(value, (bool, int, float, str, bytes, Path)):
        return
    identity = id(value)
    if identity in seen:
        return
    seen.add(identity)
    if dataclasses.is_dataclass(value):
        for field in dataclasses.fields(value):
            _assert_no_forbidden_graph(test, getattr(value, field.name), seen)
    elif isinstance(value, dict):
        for key, item in value.items():
            _assert_no_forbidden_graph(test, key, seen)
            _assert_no_forbidden_graph(test, item, seen)
    elif isinstance(value, (list, tuple, set, frozenset)):
        for item in value:
            _assert_no_forbidden_graph(test, item, seen)


class BrowserGuardPublicApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.evidence = secure_temp_directory("sde-qe-browserguard-api-test-")
        self.fake_page = _FakePage()
        self.page = _make_guarded_page(_FakeHarness(self.evidence), self.fake_page)

    def tearDown(self) -> None:
        shutil.rmtree(self.evidence, ignore_errors=True)

    def test_guarded_page_public_surface_is_exact_allowlist(self) -> None:
        public_names = {name for name in dir(self.page) if not name.startswith("_")}
        self.assertEqual(public_names, PUBLIC_GUARDED_PAGE_API)
        self.assertFalse(hasattr(self.page, "__dict__"))

    def test_module_exports_only_the_documented_facade(self) -> None:
        self.assertEqual(
            set(guard_module.__all__),
            {
                "GuardInitializationError",
                "GuardPolicyError",
                "GuardedPage",
                "NavigationResult",
                "ProtectedBrowserHarness",
                "ScreenshotResult",
            },
        )
        for name in guard_module.__all__:
            self.assertNotIn(getattr(guard_module, name), FORBIDDEN_PLAYWRIGHT_TYPES)
        for name in ("Browser", "BrowserContext", "Page", "Request", "Response", "WebSocketRoute"):
            self.assertFalse(hasattr(guard_module, name))

    def test_harness_public_surface_is_exact_allowlist(self) -> None:
        harness = ProtectedBrowserHarness("http://127.0.0.1:9", evidence_directory=self.evidence)
        try:
            public_names = {name for name in dir(harness) if not name.startswith("_")}
            self.assertEqual(public_names, PUBLIC_HARNESS_API | PUBLIC_HARNESS_ATTRIBUTES)
        finally:
            harness.close()

    def test_unknown_operations_and_raw_control_names_fail_closed(self) -> None:
        for name in (
            "context",
            "evaluate",
            "expect_popup",
            "frames",
            "on",
            "request",
            "route",
            "unroute",
            "websocket",
        ):
            with self.subTest(name=name), self.assertRaises(GuardPolicyError):
                getattr(self.page, name)

    def test_documented_returns_are_sanitized(self) -> None:
        results = [
            self.page.goto("http://127.0.0.1:9/visible?secret=discarded"),
            self.page.text("h1"),
            self.page.attribute("h1", "aria-label"),
            self.page.locator_count("li"),
            self.page.is_visible("h1"),
            self.page.set_viewport(1280, 720),
            self.page.scroll_by(0, 400),
            self.page.wait_until_loaded("domcontentloaded"),
            self.page.screenshot("facade.png"),
            self.page.close(),
        ]
        self.assertIsInstance(results[0], NavigationResult)
        self.assertEqual(results[0].path, "/visible")
        self.assertIsInstance(results[-2], ScreenshotResult)
        for result in results:
            _assert_no_forbidden_graph(self, result)

    def test_visible_attribute_names_are_allowlisted(self) -> None:
        with self.assertRaises(GuardPolicyError):
            self.page.attribute("a", "href")

    def test_result_dtos_are_immutable(self) -> None:
        result = self.page.goto("http://127.0.0.1:9/")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            result.path = "/changed"  # type: ignore[misc]

    def test_report_collections_and_nested_values_are_sanitized(self) -> None:
        harness = ProtectedBrowserHarness("http://127.0.0.1:9", evidence_directory=self.evidence)
        try:
            _assert_no_forbidden_graph(self, harness.report())
        finally:
            harness.close()

    def test_no_public_callback_or_event_registration_exists(self) -> None:
        forbidden = {"add_listener", "on", "once", "remove_listener", "wait_for_event"}
        self.assertTrue(forbidden.isdisjoint(PUBLIC_GUARDED_PAGE_API | PUBLIC_HARNESS_API))


if __name__ == "__main__":
    unittest.main(verbosity=2)
