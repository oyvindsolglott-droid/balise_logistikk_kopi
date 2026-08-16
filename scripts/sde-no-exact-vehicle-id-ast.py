#!/usr/bin/env python3
"""AST half of SDE-NO-EXACT-VEHICLE-ID-BEHAVIOR-POLICY."""

import ast
import json
import re
import subprocess
from pathlib import Path


VEHICLE = re.compile(r"(?:69|70|72|74|75)-\d{2}")


def is_fixture(path: str) -> bool:
    name = Path(path).name
    return (
        path.startswith(("tests/", "archive_7_0/"))
        or name.startswith("test_")
        or name == "sde_scenarios.py"
    )


class PolicyVisitor(ast.NodeVisitor):
    def __init__(self, path: str):
        self.path = path
        self.violations = []

    @staticmethod
    def literals(node):
        values = []
        for child in ast.walk(node):
            if isinstance(child, ast.Constant) and isinstance(child.value, str):
                values.extend(VEHICLE.findall(child.value))
        return sorted(set(values))

    def record(self, node, kind: str):
        for literal in self.literals(node):
            self.violations.append({
                "file": self.path,
                "line": getattr(node, "lineno", 0),
                "literal": literal,
                "astNode": kind,
            })

    def visit_If(self, node):
        self.record(node.test, "If.test")
        self.generic_visit(node)

    def visit_IfExp(self, node):
        self.record(node.test, "IfExp.test")
        self.generic_visit(node)

    def visit_Match(self, node):
        for case in node.cases:
            self.record(case.pattern, "Match.case")
        self.generic_visit(node)


def main():
    root = Path.cwd()
    tracked = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "*.py"],
        text=True,
    ).splitlines()
    violations = []
    parsed = 0
    for relative in tracked:
        if is_fixture(relative):
            continue
        path = root / relative
        if not path.is_file():
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=relative)
        except (SyntaxError, UnicodeDecodeError) as error:
            violations.append({"file": relative, "line": 0, "literal": "", "astNode": "parse_error", "error": str(error)})
            continue
        parsed += 1
        visitor = PolicyVisitor(relative)
        visitor.visit(tree)
        violations.extend(visitor.violations)
    print(json.dumps({"schemaVersion": "sde-no-exact-vehicle-id-python-ast-v1", "parsedFiles": parsed, "violations": violations}, sort_keys=True))
    raise SystemExit(1 if violations else 0)


if __name__ == "__main__":
    main()
