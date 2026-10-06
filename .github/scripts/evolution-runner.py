"""Start the existing dedicated EC2 runner; never provision or reconfigure it."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

PREFIX = "GITNEXUS_EVOLUTION_"
DAYS = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")
STOP_PATTERN = re.compile(r"(MON|TUE|WED|THU|FRI|SAT|SUN) ([01]\d|2[0-3]):([0-5]\d)")


def configuration() -> dict[str, str]:
    values = {}
    for name in ("AWS_REGION", "AWS_ROLE_ARN", "EC2_INSTANCE_ID", "STOP_SCHEDULE_UTC"):
        value = os.environ.get(PREFIX + name, "")
        if not value:
            raise ValueError(f"configure protected environment setting {PREFIX + name}")
        values[name] = value
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d", values["AWS_REGION"]):
        raise ValueError("invalid AWS region")
    if not re.fullmatch(
        r"arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role/[A-Za-z0-9_+=,.@/-]+",
        values["AWS_ROLE_ARN"],
    ):
        raise ValueError("invalid AWS role ARN")
    if not re.fullmatch(r"i-(?:[0-9a-f]{8}|[0-9a-f]{17})", values["EC2_INSTANCE_ID"]):
        raise ValueError("invalid EC2 instance ID")
    if STOP_PATTERN.fullmatch(values["STOP_SCHEDULE_UTC"]) is None:
        raise ValueError(
            "STOP_SCHEDULE_UTC must name the actual weekly stop as DAY HH:MM in UTC"
        )
    return values


def stop_deadline(schedule: str, *, now: datetime | None = None) -> int:
    """Bound dispatches by both 24h and the actual weekly EventBridge stop."""
    match = STOP_PATTERN.fullmatch(schedule)
    if match is None:
        raise ValueError(
            "STOP_SCHEDULE_UTC must name the actual weekly stop as DAY HH:MM in UTC"
        )
    now = now or datetime.now(UTC)
    stop = now.replace(
        hour=int(match[2]), minute=int(match[3]), second=0, microsecond=0
    )
    stop += timedelta(days=(DAYS.index(match[1]) - now.weekday()) % 7)
    # EventBridge may fire anywhere within its scheduled minute. Fail closed
    # during that minute rather than treating it as a new seven-day window.
    if stop <= now < stop + timedelta(minutes=1):
        raise ValueError("the configured EventBridge stop is due now")
    if stop < now:
        stop += timedelta(days=7)
    deadline = min(stop, now + timedelta(hours=24))
    if (deadline - now).total_seconds() < 600 + 5400:
        raise ValueError(
            "insufficient time before the configured stop and evidence-upload reserve"
        )
    return int(deadline.timestamp())


def aws(values: dict[str, str], operation: str, *extra: str) -> dict:
    result = subprocess.run(
        [
            "aws",
            "ec2",
            operation,
            "--instance-ids",
            values["EC2_INSTANCE_ID"],
            "--region",
            values["AWS_REGION"],
            "--output",
            "json",
            "--no-cli-pager",
            *extra,
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode:
        # AWS diagnostics can include private account/instance topology.
        raise RuntimeError(
            f"EC2 {operation} failed; verify the protected role's scoped permissions"
        )
    return json.loads(result.stdout)


def instance_state(values: dict[str, str]) -> str:
    response = aws(values, "describe-instances")
    instances = [
        i for r in response.get("Reservations", []) for i in r.get("Instances", [])
    ]
    if (
        len(instances) != 1
        or instances[0].get("InstanceId") != values["EC2_INSTANCE_ID"]
    ):
        raise RuntimeError("EC2 did not return exactly the configured instance")
    return instances[0].get("State", {}).get("Name", "unknown")


def healthy(values: dict[str, str]) -> bool:
    statuses = aws(values, "describe-instance-status", "--include-all-instances").get(
        "InstanceStatuses", []
    )
    return (
        len(statuses) == 1
        and statuses[0].get("InstanceId") == values["EC2_INSTANCE_ID"]
        and all(
            statuses[0].get(field, {}).get("Status") == "ok"
            for field in ("SystemStatus", "InstanceStatus")
        )
    )


def output(name: str, value: str) -> None:
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as handle:
        handle.write(f"{name}={value}\n")


def wait_for_runner(*, timeout: float = 300) -> None:
    """Require this run's queued native probe to finish; EC2 health is not pickup."""
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    if repository != "abhigyanpatwari/GitNexus" or not re.fullmatch(r"\d+", run_id):
        raise ValueError(
            "runner pickup requires this repository's current workflow run"
        )
    until = time.monotonic() + timeout
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
            if job.get("name") == "Verify the runner service is online"
        ]
        if len(probes) > 1:
            raise RuntimeError("current run has multiple runner pickup probes")
        if probes and probes[0].get("status") == "completed":
            if probes[0].get("conclusion") != "success":
                raise RuntimeError("runner pickup probe failed")
            return
        time.sleep(min(10, max(0, until - time.monotonic())))
    raise RuntimeError(
        "runner service did not complete its pickup probe before the deadline"
    )


def start(values: dict[str, str], *, timeout: float = 900) -> None:
    deadline_epoch = stop_deadline(values["STOP_SCHEDULE_UTC"])
    until = time.monotonic() + timeout
    started = False
    try:
        while time.monotonic() < until:
            state = instance_state(values)
            if state == "stopped":
                if started:
                    raise RuntimeError("EC2 stopped again during bootstrap")
                aws(values, "start-instances")
                started = True
                output("started", "true")
            elif state == "running" and healthy(values):
                wait_for_runner()
                output("started", str(started).lower())
                output("stop_deadline_epoch", str(deadline_epoch))
                print(
                    "Dedicated EC2 instance is healthy and its runner completed this run's native pickup probe."
                )
                return
            elif state not in ("running", "pending", "stopping"):
                raise RuntimeError(f"EC2 cannot start from state {state}")
            time.sleep(min(10, max(0, until - time.monotonic())))
        raise RuntimeError("EC2 startup/health deadline expired")
    except BaseException:
        if started:
            try:
                aws(values, "stop-instances")
            except (
                RuntimeError,
                subprocess.TimeoutExpired,
                OSError,
                json.JSONDecodeError,
            ):
                print(
                    "::error::EC2 cleanup also failed; use the external stop watchdog"
                )
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("check", "start", "stop"))
    args = parser.parse_args()
    values = configuration()
    for name in ("AWS_ROLE_ARN", "EC2_INSTANCE_ID"):
        print(f"::add-mask::{values[name]}")
    if args.operation == "start":
        start(values)
    elif args.operation == "stop":
        aws(values, "stop-instances")
        print("Stopped the dedicated instance started by this workflow.")


if __name__ == "__main__":
    try:
        main()
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
            else "runner bootstrap command failed"
        )
        print(f"::error::{message}")
        raise SystemExit(1) from None
