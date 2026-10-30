"""Bounded verifier evidence without publishing candidate or hidden-test output."""

from __future__ import annotations

from typing import Any

from .runner_artifacts import VerificationResult

# These are observed text markers, not authoritative diagnoses. Never publish
# matched text: candidate code can print source, credentials, or hidden tests.
MARKERS = {
    "assertion_failure": ("AssertionError",),
    "startup_failure": ("Failed Suites", "Startup Error", "Unhandled Errors", "Cannot find module"),
    "permission_failure": ("EACCES", "EROFS", "Permission denied", "Failed to create Vitest API token"),
    "typecheck_failure": ("error TS",),
}


def verification_metrics(result: VerificationResult | tuple[bool, str], elapsed: float) -> dict[str, Any]:
    passed, output = result
    return {
        "passed": passed,
        "duration_s": elapsed,
        "exit_code": result.process.returncode if isinstance(result, VerificationResult) else None,
        "state": result.process.state if isinstance(result, VerificationResult) else "unknown",
        **{field: any(marker in output for marker in markers) for field, markers in MARKERS.items()},
    }


def public_verification(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    code, elapsed, state = value.get("exit_code"), value.get("duration_s"), value.get("state")
    return {
        "exit_code": code if type(code) is int and -255 <= code <= 255 else None,
        "duration_s": elapsed if type(elapsed) in (int, float) and 0 <= elapsed <= 10**12 else None,
        "state": state if state in ("exited", "timeout", "cancelled", "spawn-failure", "forced-kill",
                                     "ownership-failure", "reap-failure", "cleanup-failure", "unknown") else "unknown",
        **{field: value.get(field) if type(value.get(field)) is bool else None
           for field in ("passed", *MARKERS)},
    }
