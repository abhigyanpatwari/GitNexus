"""Bound this run's native probe or paid job pickup to five minutes."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time


def wait_for_runner(*, timeout: float = 300, evolve: bool = False) -> None:
    """Require probe success or bound pickup of the actual paid job."""
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    if repository != "abhigyanpatwari/GitNexus" or not re.fullmatch(r"\d+", run_id):
        raise ValueError(
            "runner pickup requires this repository's current workflow run"
        )
    until = time.monotonic() + timeout
    job_name = (
        "Propose, benchmark, and gate skill candidates"
        if evolve
        else "Verify the runner service is online"
    )
    while time.monotonic() < until:
        result = subprocess.run(
            [
                "gh",
                "api",
                f"repos/{repository}/actions/runs/{run_id}/jobs?per_page=100",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode:
            raise RuntimeError(
                "cannot verify runner pickup through the current run's jobs API"
            )
        jobs = json.loads(result.stdout).get("jobs", [])
        probes = [
            job
            for job in jobs
            if job.get("name") == job_name
        ]
        if len(probes) > 1:
            raise RuntimeError("current run has multiple runner pickup probes")
        if evolve and probes:
            if probes[0].get("status") == "in_progress":
                return
            if probes[0].get("status") == "completed":
                if probes[0].get("conclusion") in ("skipped", "cancelled"):
                    raise RuntimeError("evolution job did not run")
                return
        if probes and probes[0].get("status") == "completed":
            if probes[0].get("conclusion") != "success":
                raise RuntimeError("runner pickup probe failed")
            return
        time.sleep(min(10, max(0, until - time.monotonic())))
    raise RuntimeError(
        "runner service did not complete its pickup probe before the deadline"
    )


if __name__ == "__main__":
    try:
        if sys.argv[1:] not in ([], ["--evolve"]):
            raise ValueError("expected no arguments or --evolve")
        wait_for_runner(evolve=sys.argv[1:] == ["--evolve"])
        print("The dedicated runner picked up this run's requested job.")
    except (
        ValueError,
        RuntimeError,
        subprocess.TimeoutExpired,
        OSError,
        json.JSONDecodeError,
    ) as exc:
        message = (
            str(exc)
            if isinstance(exc, (ValueError, RuntimeError))
            else "runner readiness command failed"
        )
        print(f"::error::{message}")
        raise SystemExit(1) from None
