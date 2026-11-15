"""Start and stop the existing dedicated EC2 runner without provisioning resources.

Call only from trusted hosted jobs under the shared evolution/release concurrency
group. The instance is dedicated to that group, so an already-running instance is
also claimed for cleanup. GitHub runner pickup is checked separately.
"""

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
START_TIMEOUT = 600
STOP_TIMEOUT = 600
EVIDENCE_RESERVE = 90 * 60


def configuration() -> dict[str, str]:
    values = {}
    for name in ("AWS_REGION", "AWS_ROLE_ARN", "EC2_INSTANCE_ID", "STOP_SCHEDULE_UTC"):
        value = os.environ.get(PREFIX + name, "")
        if not value:
            raise ValueError(f"configure protected environment setting {PREFIX + name}")
        values[name] = value
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d", values["AWS_REGION"]):
        raise ValueError("invalid AWS region")
    if not re.fullmatch(r"arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role/[A-Za-z0-9_+=,.@/-]+", values["AWS_ROLE_ARN"]):
        raise ValueError("invalid AWS role ARN")
    if not re.fullmatch(r"i-(?:[0-9a-f]{8}|[0-9a-f]{17})", values["EC2_INSTANCE_ID"]):
        raise ValueError("invalid EC2 instance ID")
    if STOP_PATTERN.fullmatch(values["STOP_SCHEDULE_UTC"]) is None:
        raise ValueError("STOP_SCHEDULE_UTC must name the actual weekly stop as DAY HH:MM in UTC")
    return values


def stop_deadline(schedule: str, *, now: datetime | None = None) -> int:
    """Reserve startup/upload time and respect both the weekly stop and a 24h cap."""
    match = STOP_PATTERN.fullmatch(schedule)
    if match is None:
        raise ValueError("STOP_SCHEDULE_UTC must name the actual weekly stop as DAY HH:MM in UTC")
    now = now or datetime.now(UTC)
    if now.tzinfo is None:
        raise ValueError("stop deadline requires an explicit timezone")
    now = now.astimezone(UTC)
    scheduled = now.replace(hour=int(match[2]), minute=int(match[3]), second=0, microsecond=0)
    scheduled += timedelta(days=(DAYS.index(match[1]) - now.weekday()) % 7)
    # EventBridge may fire anywhere within its scheduled minute. Starting during
    # that minute must not be interpreted as having a fresh seven-day window.
    if scheduled <= now < scheduled + timedelta(minutes=1):
        raise ValueError("the configured EventBridge stop is due now")
    if scheduled < now:
        scheduled += timedelta(days=7)
    deadline = min(scheduled, now + timedelta(hours=24))
    if (deadline - now).total_seconds() < START_TIMEOUT + EVIDENCE_RESERVE:
        raise ValueError("insufficient time before the configured stop and evidence-upload reserve")
    return int(deadline.timestamp())


class CommandError(RuntimeError):
    """The AWS CLI call itself failed, timed out, or returned unusable output."""


def aws(values: dict[str, str], operation: str, *extra: str, until: float | None = None) -> dict:
    """Keep each command within the remaining budget and hide AWS diagnostics."""
    timeout = 30 if until is None else min(30, until - time.monotonic())
    if timeout <= 0:
        raise CommandError("EC2 command deadline expired")
    try:
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
            timeout=timeout,
        )
    except (subprocess.TimeoutExpired, OSError):
        # TimeoutExpired includes the full command; never expose private IDs.
        raise CommandError(f"EC2 {operation} command failed or timed out") from None
    if result.returncode:
        raise CommandError(f"EC2 {operation} failed; verify the protected role's scoped permissions")
    try:
        response = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        raise CommandError(f"EC2 {operation} returned an invalid response") from None
    if not isinstance(response, dict):
        raise CommandError(f"EC2 {operation} returned an invalid response")
    return response


def instance_state(values: dict[str, str], *, until: float | None = None) -> str:
    response = aws(values, "describe-instances", until=until)
    try:
        instances = [instance for reservation in response["Reservations"] for instance in reservation["Instances"]]
        if len(instances) != 1 or instances[0].get("InstanceId") != values["EC2_INSTANCE_ID"]:
            raise ValueError
        state = instances[0].get("State", {}).get("Name")
    except (KeyError, TypeError, AttributeError, ValueError):
        raise RuntimeError("EC2 did not return exactly the configured instance") from None
    if state not in ("stopped", "stopping", "pending", "running"):
        raise RuntimeError("EC2 instance state does not permit this lifecycle operation")
    return state


def healthy(values: dict[str, str], *, until: float | None = None) -> bool:
    response = aws(values, "describe-instance-status", "--include-all-instances", until=until)
    statuses = response.get("InstanceStatuses", [])
    if statuses == []:
        return False  # Status checks can lag behind the running state.
    if (
        not isinstance(statuses, list)
        or len(statuses) != 1
        or not isinstance(statuses[0], dict)
        or statuses[0].get("InstanceId") != values["EC2_INSTANCE_ID"]
    ):
        raise RuntimeError("EC2 status did not return exactly the configured instance")
    return all(
        isinstance(statuses[0].get(field), dict) and statuses[0][field].get("Status") == "ok"
        for field in ("SystemStatus", "InstanceStatus")
    )


def output(name: str, value: str) -> None:
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as handle:
        handle.write(f"{name}={value}\n")


def pause(until: float) -> None:
    time.sleep(min(10, max(0, until - time.monotonic())))


def stop(values: dict[str, str], *, timeout: float = STOP_TIMEOUT) -> None:
    """Gracefully stop and observe stopped; an accepted API call is insufficient."""
    until = time.monotonic() + timeout
    failure: CommandError | None = None
    while time.monotonic() < until:
        try:
            state = instance_state(values, until=until)
        except CommandError as error:
            # A failed or timed-out describe is unknown state, not proof of
            # either outcome. Keep observing within the same stop budget; an
            # unusable state or identity mismatch still fails at once.
            failure = error
            pause(until)
            continue
        failure = None
        if state == "stopped":
            print("Dedicated EC2 instance confirmed stopped.")
            return
        if state == "running":
            try:
                aws(values, "stop-instances", until=until)
            except RuntimeError:
                # A timeout can lose an accepted response. Observe state again;
                # retry only while still running, within the same stop budget.
                pass
        # StopInstances is invalid for pending instances. Wait for running; for
        # stopping instances, wait for the real terminal stopped state.
        pause(until)
    if failure is not None:
        raise RuntimeError(f"EC2 shutdown deadline expired after: {failure}; use the external stop watchdog")
    raise RuntimeError("EC2 shutdown deadline expired; use the external stop watchdog")


def start(values: dict[str, str], *, timeout: float = START_TIMEOUT, cleanup_timeout: float = STOP_TIMEOUT) -> None:
    deadline_epoch = stop_deadline(values["STOP_SCHEDULE_UTC"])
    until = time.monotonic() + timeout
    claimed = False
    requested = False
    try:
        while time.monotonic() < until:
            state = instance_state(values, until=until)
            if state != "stopping" and not claimed:
                # Persist cleanup ownership BEFORE StartInstances: an accepted
                # call can time out or the hosted process can be interrupted.
                output("cleanup_required", "true")
                claimed = True
            if state == "stopped":
                if requested:
                    raise RuntimeError("EC2 stopped again during bootstrap")
                requested = True
                aws(values, "start-instances", until=until)
            elif state == "running" and healthy(values, until=until):
                output("stop_deadline_epoch", str(deadline_epoch))
                print("Dedicated EC2 instance is running with healthy system and instance checks.")
                return
            pause(until)
        raise RuntimeError("EC2 startup/health deadline expired")
    except BaseException:
        if claimed:
            try:
                stop(values, timeout=cleanup_timeout)
            except (RuntimeError, OSError):
                print(
                    "::error::EC2 cleanup also failed; hosted cleanup must retry and the external stop watchdog remains required"
                )
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("check", "start", "stop"))
    args = parser.parse_args()
    values = configuration()
    if args.operation == "check":
        stop_deadline(values["STOP_SCHEDULE_UTC"])
        print("Dedicated runner configuration and stop window validated.")
    elif args.operation == "start":
        start(values)
    else:
        # Shutdown must still run after the startup window or stop deadline.
        stop(values)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, KeyError) as exc:
        message = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else "runner lifecycle command failed"
        print(f"::error::{message}")
        raise SystemExit(1) from None
