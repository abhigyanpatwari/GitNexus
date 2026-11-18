"""Run evaluator-owned work in a disposable container on a stock Linux host."""

from __future__ import annotations

import csv
import io
import os
import selectors
import shutil
import socket
import sys
import tempfile
import threading
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path

from .process_control import ManagedProcessError, ManagedProcessResult, run_managed
from .proposer_sandbox import ReadOnlyMount, SandboxError


# Official multi-architecture manifest, shared by CI and operator runs.
WORKER_IMAGE = (
    "docker.io/library/node:22.18.0-trixie@sha256:5329a2a013f6a49e8698609f9b20aa9aac670672ab6d88af73e3517cd79790e7"
)


def _bind(source: Path, target: str, *, readonly: bool) -> str:
    fields = ["type=bind", f"source={source}", f"target={target}"]
    if readonly:
        fields.append("readonly")
    # Docker parses --mount using CSV even when argv is passed without a shell.
    record = io.StringIO()
    csv.writer(record).writerow(fields)
    return record.getvalue().removesuffix("\r\n")


def _hold_workers(listener: socket.socket, stop: threading.Event) -> None:
    # A command prefix starts one worker at a time. PID 1 opens the lease
    # before starting its workload. Only accept the next worker after it exits.
    listener.settimeout(0.1)
    while not stop.is_set():
        try:
            connection, _ = listener.accept()
        except TimeoutError:
            continue
        with connection, selectors.DefaultSelector() as completed:
            completed.register(connection, selectors.EVENT_READ)
            while not stop.is_set():
                if completed.select(0.1):
                    break


@contextmanager
def worker_command(
    *,
    checkout: Path,
    readonly: bool,
    mounts: Sequence[ReadOnlyMount] = (),
    environment: Mapping[str, str] | None = None,
    writable_mounts: Sequence[ReadOnlyMount] = (),
    registry_download: bool = False,
    interactive: bool = False,
    completed: list[int] | None = None,
) -> Iterator[list[str]]:
    """Own the lifetime of workers started with this fixed filesystem and network policy."""
    docker = shutil.which("docker", path="/usr/local/bin:/usr/bin:/bin")
    if sys.platform != "linux" or docker is None or os.getuid() == 0:
        raise SandboxError("the evaluator worker requires a non-root user with access to local Docker Engine")
    with tempfile.TemporaryDirectory(prefix="gnx-oci-") as private, socket.socket(socket.AF_UNIX) as lease:
        owner = Path(private) / "owner"
        lease.bind(str(owner))
        owner.chmod(0o600)
        lease.listen(1)
        argv = [
            docker,
            "--host",
            "unix:///var/run/docker.sock",
            "--config",
            private,
            "run",
            "--rm",
            "--init=false",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--security-opt=apparmor=docker-default",
            "--pids-limit=512",
            f"--user={os.getuid()}:{os.getgid()}",
            "--network=bridge" if registry_download else "--network=none",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,mode=1777",
            "--tmpfs",
            f"/home/agent:rw,nosuid,nodev,mode=0700,uid={os.getuid()},gid={os.getgid()}",
            "--workdir",
            "/workspace",
            "--env",
            "HOME=/home/agent",
            "--mount",
            _bind(checkout, "/workspace", readonly=readonly),
            "--mount",
            _bind(owner, "/run/gnx-owner.sock", readonly=True),
            "--mount",
            _bind(Path(__file__).with_name("worker_init.py"), "/run/gnx-worker.py", readonly=True),
        ]
        if interactive:
            argv.append("--interactive")
        for mount in mounts:
            argv.extend(("--mount", _bind(mount.source, mount.target, readonly=True)))
            if Path(mount.target).name == "node_modules" and (mount.source / ".vite-temp").is_dir():
                argv.extend(("--tmpfs", f"{mount.target}/.vite-temp:rw,nosuid,nodev,mode=1777"))
        for mount in writable_mounts:
            argv.extend(("--mount", _bind(mount.source, mount.target, readonly=False)))
        for key, value in (environment or {}).items():
            argv.extend(("--env", f"{key}={value}"))
        argv.extend(("--entrypoint", "/usr/bin/python3", WORKER_IMAGE, "-I", "/run/gnx-worker.py"))
        if completed is not None:
            # PID 1 connects before it spawns the workload. Read its status
            # from that first private stream after the Docker client exits.
            # A daemon/startup error cannot masquerade as a candidate failure.
            yield argv
            lease.settimeout(0.5)
            try:
                connection, _ = lease.accept()
                with connection:
                    connection.settimeout(0.5)
                    completed.extend(connection.recv(2))
            except (TimeoutError, ConnectionResetError):
                # run_worker rejects the result when the worker has not confirmed its exit.
                pass
            return
        stop = threading.Event()
        supervisor = threading.Thread(target=_hold_workers, args=(lease, stop), daemon=True)
        supervisor.start()
        try:
            yield argv
        finally:
            stop.set()
            supervisor.join()


def run_worker(
    command: Sequence[str],
    *,
    checkout: Path,
    readonly: bool,
    timeout: int,
    mounts: Sequence[ReadOnlyMount] = (),
    environment: Mapping[str, str] | None = None,
    registry_download: bool = False,
    check: bool = True,
) -> ManagedProcessResult:
    """Run one evaluator-selected command. The task and its children get no daemon socket."""
    completed: list[int] = []
    with worker_command(
        checkout=checkout,
        readonly=readonly,
        mounts=mounts,
        environment=environment,
        registry_download=registry_download,
        completed=completed,
    ) as prefix:
        result = run_managed([*prefix, *command], timeout=timeout, env={})
    if result.state != "exited" or completed != [result.returncode]:
        raise SandboxError(f"OCI worker did not confirm completion ({result.state}, exit={result.returncode})")
    if check and not result.ok:
        raise ManagedProcessError(command, result)
    return result
