"""Validation and lookup for committed read-only Browserguard interaction plans."""

from __future__ import annotations

import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Iterable


PLAN_VERSION = "sde-browserguard-readonly-interaction-plan/v1"
ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
ACTION_TYPES = frozenset(
    {"NAVIGATION", "MENU_TOGGLE", "TAB_SWITCH", "READONLY_DETAIL", "CLOSE_OVERLAY", "FOCUS", "SAFE_KEY"}
)
SAFE_KEYS = frozenset(
    {"Tab", "Shift+Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"}
)
READ_TYPES = frozenset({"TEXT", "ATTRIBUTE", "COUNT", "VISIBLE"})
SAFE_ATTRIBUTES = frozenset({"alt", "class", "id", "role", "title"})
SAFE_TAGS = frozenset({"a", "button", "div"})
SAFE_ROLES = frozenset({"button", "tab"})
MUTATING_TOKENS = frozenset(
    {
        "annuller",
        "cancel",
        "complete",
        "delete",
        "lagre",
        "override",
        "overprøv",
        "save",
        "submit",
        "update",
        "utført",
        "oppdater",
    }
)


class InteractionPlanError(RuntimeError):
    """Raised when a plan, target or action violates read-only policy."""


def _exact_fields(value: Any, expected: Iterable[str], label: str) -> Dict[str, Any]:
    if not isinstance(value, dict) or set(value) != set(expected):
        raise InteractionPlanError(f"{label} fields are invalid")
    return value


def _valid_id(value: Any) -> bool:
    return isinstance(value, str) and ID_PATTERN.fullmatch(value) is not None


class ReadOnlyInteractionPlan:
    """Immutable-by-copy lookup facade over one validated committed plan."""

    def __init__(self, value: Dict[str, Any], *, target_origin: str) -> None:
        _exact_fields(
            value,
            {"schemaVersion", "planId", "targetOrigin", "allowedPaths", "viewports", "targets", "actions"},
            "plan",
        )
        if value["schemaVersion"] != PLAN_VERSION or not _valid_id(value["planId"]):
            raise InteractionPlanError("plan identity is invalid")
        if value["targetOrigin"] != "$BROKER_SENTINEL":
            raise InteractionPlanError("synthetic plan must use the broker sentinel origin token")
        self.plan_id = value["planId"]
        self.target_origin = target_origin
        self.allowed_paths = self._validate_paths(value["allowedPaths"])
        self._viewports = self._validate_viewports(value["viewports"])
        self._targets = self._validate_targets(value["targets"])
        self._actions = self._validate_actions(value["actions"])

    @classmethod
    def synthetic(cls, *, target_origin: str) -> "ReadOnlyInteractionPlan":
        path = Path(__file__).resolve().parent / "fixtures" / "synthetic-readonly-plan.json"
        return cls(json.loads(path.read_text(encoding="utf-8")), target_origin=target_origin)

    def _validate_paths(self, values: Any) -> frozenset[str]:
        if not isinstance(values, list) or not values:
            raise InteractionPlanError("allowed paths must be a non-empty array")
        paths = set()
        for value in values:
            if not isinstance(value, str) or not value.startswith("/") or "?" in value or "#" in value or ".." in value:
                raise InteractionPlanError("allowed path is invalid")
            paths.add(value)
        if len(paths) != len(values):
            raise InteractionPlanError("allowed paths must be unique")
        return frozenset(paths)

    def _validate_viewports(self, values: Any) -> Dict[str, Dict[str, int]]:
        if not isinstance(values, list) or not values:
            raise InteractionPlanError("viewports must be a non-empty array")
        result = {}
        for value in values:
            _exact_fields(value, {"id", "width", "height"}, "viewport")
            identifier = value["id"]
            if not _valid_id(identifier) or identifier in result:
                raise InteractionPlanError("viewport ID is invalid or duplicated")
            if not all(isinstance(value[key], int) and not isinstance(value[key], bool) and 1 <= value[key] <= 10_000 for key in ("width", "height")):
                raise InteractionPlanError("viewport dimensions are invalid")
            result[identifier] = {"width": value["width"], "height": value["height"]}
        return result

    def _validate_targets(self, values: Any) -> Dict[str, Dict[str, Any]]:
        if not isinstance(values, list) or not values:
            raise InteractionPlanError("targets must be a non-empty array")
        result = {}
        for value in values:
            _exact_fields(value, {"id", "selector", "reads", "attributes"}, "target")
            identifier = value["id"]
            if not _valid_id(identifier) or identifier in result:
                raise InteractionPlanError("target ID is invalid or duplicated")
            if not isinstance(value["selector"], str) or not 1 <= len(value["selector"]) <= 200:
                raise InteractionPlanError("target selector is invalid")
            reads = value["reads"]
            attributes = value["attributes"]
            if not isinstance(reads, list) or len(reads) != len(set(reads)) or not set(reads).issubset(READ_TYPES):
                raise InteractionPlanError("target read allowlist is invalid")
            if not isinstance(attributes, list) or len(attributes) != len(set(attributes)):
                raise InteractionPlanError("target attribute allowlist is invalid")
            if any(
                not isinstance(item, str)
                or (item not in SAFE_ATTRIBUTES and re.fullmatch(r"aria-[a-z-]+", item) is None)
                for item in attributes
            ):
                raise InteractionPlanError("target attribute is not allowlisted")
            result[identifier] = deepcopy(value)
        return result

    def _validate_actions(self, values: Any) -> Dict[str, Dict[str, Any]]:
        if not isinstance(values, list) or not values:
            raise InteractionPlanError("actions must be a non-empty array")
        result = {}
        common = {"id", "type"}
        interactive = common | {"targetId", "expectedTag", "expectedRole"}
        for value in values:
            if not isinstance(value, dict):
                raise InteractionPlanError("action must be an object")
            identifier = value.get("id")
            action_type = value.get("type")
            if not _valid_id(identifier) or identifier in result or action_type not in ACTION_TYPES:
                raise InteractionPlanError("action identity or type is invalid")
            expected_fields = common | {"path"} if action_type == "NAVIGATION" else interactive
            if action_type == "SAFE_KEY":
                expected_fields = interactive | {"key"}
            elif action_type == "READONLY_DETAIL":
                expected_fields = interactive | {"resultKind"}
            _exact_fields(value, expected_fields, f"{action_type} action")
            if action_type == "NAVIGATION":
                if value["path"] not in self.allowed_paths:
                    raise InteractionPlanError("navigation path is not allowlisted")
            else:
                if value["targetId"] not in self._targets:
                    raise InteractionPlanError("action target ID is not declared")
                if value["expectedTag"] not in SAFE_TAGS or value["expectedRole"] not in SAFE_ROLES:
                    raise InteractionPlanError("action element semantics are not read-only allowlisted")
            if action_type == "SAFE_KEY" and value["key"] not in SAFE_KEYS:
                raise InteractionPlanError("keyboard action is not allowlisted")
            if action_type == "READONLY_DETAIL" and value["resultKind"] not in {"dialog", "popup"}:
                raise InteractionPlanError("detail result kind is invalid")
            result[identifier] = deepcopy(value)
        return result

    def target(self, identifier: str, read_type: str | None = None) -> Dict[str, Any]:
        try:
            target = self._targets[identifier]
        except (KeyError, TypeError) as error:
            raise InteractionPlanError("target ID is not declared") from error
        if read_type is not None and read_type not in target["reads"]:
            raise InteractionPlanError("read operation is not allowed for target")
        return deepcopy(target)

    def action(self, identifier: str, expected_type: str | None = None) -> Dict[str, Any]:
        try:
            action = self._actions[identifier]
        except (KeyError, TypeError) as error:
            raise InteractionPlanError("action ID is not declared") from error
        if expected_type is not None and action["type"] != expected_type:
            raise InteractionPlanError("action type does not match command")
        return deepcopy(action)

    def viewport(self, identifier: str) -> Dict[str, int]:
        try:
            return dict(self._viewports[identifier])
        except (KeyError, TypeError) as error:
            raise InteractionPlanError("viewport ID is not declared") from error


def validate_element_policy(action: Dict[str, Any], descriptor: Dict[str, Any]) -> None:
    _exact_fields(
        descriptor,
        {"tag", "role", "type", "contenteditable", "draggable", "formAncestor", "accessibleName"},
        "element descriptor",
    )
    tag = str(descriptor["tag"] or "").lower()
    role = str(descriptor["role"] or "").lower()
    input_type = str(descriptor["type"] or "").lower()
    accessible_name = str(descriptor["accessibleName"] or "").lower()
    if tag in {"form", "input", "textarea", "select", "option"}:
        raise InteractionPlanError("form and editable elements are prohibited")
    if input_type in {"file", "submit", "reset"}:
        raise InteractionPlanError("upload and submit controls are prohibited")
    if descriptor["contenteditable"] or descriptor["draggable"] or descriptor["formAncestor"]:
        raise InteractionPlanError("editable, draggable and form-contained controls are prohibited")
    if role in {"checkbox", "radio", "spinbutton", "switch", "textbox"}:
        raise InteractionPlanError("mutable ARIA control is prohibited")
    if any(token in accessible_name for token in MUTATING_TOKENS):
        raise InteractionPlanError("known mutating action category is prohibited")
    if tag != action["expectedTag"] or role != action["expectedRole"]:
        raise InteractionPlanError("runtime element semantics do not match the committed action")
