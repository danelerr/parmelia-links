#!/usr/bin/env python3
"""Fail local release verification on new Slither medium/high findings."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ALLOWED_FINDING = {
    "check": "unused-return",
    "path": "src/ParmeliaPaymaster.sol",
    "function": "validatePaymasterUserOp",
}


def is_allowed(detector: dict[str, object]) -> bool:
    if detector.get("check") != ALLOWED_FINDING["check"]:
        return False

    elements = detector.get("elements")
    if not isinstance(elements, list):
        return False

    paths: set[str] = set()
    functions: set[str] = set()
    for element in elements:
        if not isinstance(element, dict):
            continue
        source_mapping = element.get("source_mapping")
        if isinstance(source_mapping, dict):
            relative_path = source_mapping.get("filename_relative")
            if isinstance(relative_path, str):
                paths.add(relative_path.replace("\\", "/"))
        if element.get("type") == "function":
            name = element.get("name")
            if isinstance(name, str):
                functions.add(name)

    return paths == {ALLOWED_FINDING["path"]} and functions == {
        ALLOWED_FINDING["function"]
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check-slither.py <slither-report.json>", file=sys.stderr)
        return 2

    report_path = Path(sys.argv[1])
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("success") is not True:
        print(f"Slither did not complete successfully: {report.get('error')}", file=sys.stderr)
        return 1

    results = report.get("results")
    detectors = results.get("detectors", []) if isinstance(results, dict) else []
    blocked: list[dict[str, object]] = []
    allowed: list[dict[str, object]] = []

    for detector in detectors:
        if not isinstance(detector, dict):
            continue
        impact = str(detector.get("impact", "")).lower()
        if impact not in {"medium", "high"}:
            continue
        (allowed if is_allowed(detector) else blocked).append(detector)

    if allowed:
        print(
            "Allowed Slither finding: unused tryRecover diagnostic after "
            "RecoverError is checked in ParmeliaPaymaster."
        )

    if blocked:
        print("Blocking Slither findings:", file=sys.stderr)
        for detector in blocked:
            description = str(detector.get("description", "")).strip()
            print(
                f"- {detector.get('impact')}: {detector.get('check')}: {description}",
                file=sys.stderr,
            )
        return 1

    print("Slither medium/high gate passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
