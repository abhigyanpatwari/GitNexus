"""Require a real passing execution of every pytest case across the CI jobs."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


RECEIPTS = ("pytest-locked.xml", "pytest-ubuntu.xml", "pytest-windows.xml")


def reconcile(reports: list[Path], expected_files: list[str]) -> dict:
    if not reports:
        raise ValueError("No pytest execution reports supplied")
    tests: dict[tuple[str, str], set[str]] = {}
    durations: list[float] = []
    for report in reports:
        root = ET.parse(report).getroot()
        suites = [root] if root.tag == "testsuite" else list(root.findall("testsuite"))
        if root.tag not in {"testsuite", "testsuites"} or not suites:
            raise ValueError(f"Invalid pytest report: {report}")
        seen: set[tuple[str, str]] = set()
        duration = 0.0
        for suite in suites:
            cases = suite.findall("testcase")
            if not cases:
                raise ValueError(f"Empty pytest suite in {report}")
            counts = {"tests": len(cases), "failures": 0, "errors": 0, "skipped": 0}
            for case in cases:
                key = (case.get("classname", ""), case.get("name", ""))
                if not all(key) or key in seen:
                    raise ValueError(f"Missing or ambiguous pytest identity in {report}: {key}")
                seen.add(key)
                for status in ("failures", "errors", "skipped"):
                    tag = {"failures": "failure", "errors": "error", "skipped": "skipped"}[status]
                    counts[status] += len(case.findall(tag))
                status = (
                    "failed"
                    if case.find("failure") is not None or case.find("error") is not None
                    else "pending"
                    if case.find("skipped") is not None
                    else "passed"
                )
                tests.setdefault(key, set()).add(status)
            for name, count in counts.items():
                if int(suite.get(name, "-1")) != count:
                    raise ValueError(f"Inconsistent pytest {name} count in {report}")
            duration += float(suite.get("time", "0"))
        durations.append(duration)

    modules = {module for module, _ in tests}
    for file in expected_files:
        module = file.removesuffix(".py").replace("/", ".")
        if not any(name == module or name.startswith(module + ".") for name in modules):
            raise ValueError(f"Pytest file was never collected: {file}")

    suites_by_module: dict[str, dict] = {}
    failed: list[str] = []
    pending = 0
    for (module, name), statuses in sorted(tests.items()):
        status = "failed" if "failed" in statuses else "passed" if "passed" in statuses else "pending"
        full_name = f"{module}::{name}"
        if status == "failed":
            failed.append(full_name)
        pending += status == "pending"
        suite = suites_by_module.setdefault(
            module,
            {
                "name": module,
                "status": "passed",
                "assertionResults": [],
                "endTime": round(max(durations) * 1000),
            },
        )
        suite["assertionResults"].append(
            {
                "fullName": full_name,
                "ancestorTitles": [module],
                "title": name,
                "status": status,
            }
        )
        if status == "failed":
            suite["status"] = "failed"
    return {
        "success": not failed and pending == 0,
        "numTotalTests": len(tests),
        "numPassedTests": len(tests) - len(failed) - pending,
        "numFailedTests": len(failed),
        "numPendingTests": pending,
        "numTotalTestSuites": len(suites_by_module),
        "numFailedTestSuites": sum(s["status"] == "failed" for s in suites_by_module.values()),
        "executionFailures": failed,
        "startTime": 0,
        "testResults": list(suites_by_module.values()),
    }


def main() -> int:
    if len(sys.argv) != 3:
        raise ValueError("Usage: check_test_execution.py <reports-dir> <output.json>")
    directory, output = map(Path, sys.argv[1:])
    root = Path(__file__).resolve().parent
    expected = [p.relative_to(root).as_posix() for p in (root / "tests").rglob("test_*.py")]
    report = reconcile([directory / name for name in RECEIPTS], expected)
    output.write_text(json.dumps(report), encoding="utf-8")
    print(
        f"Eval execution: {report['numPassedTests']}/{report['numTotalTests']} passed; "
        f"{report['numPendingTests']} unverified; {report['numFailedTests']} failures"
    )
    for suite in report["testResults"]:
        for case in suite["assertionResults"]:
            if case["status"] != "passed":
                print(f"{case['status']}: {case['fullName']}", file=sys.stderr)
    return 0 if report["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
