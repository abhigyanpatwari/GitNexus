"""Per-cell stdio endpoint; candidate runtime files stay outside the agent."""

from __future__ import annotations

import json
import shutil
import socket
import tempfile
import threading
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Iterator, Sequence

from .process_control import run_managed
from .proposer_sandbox import (
    SANDBOX_GITNEXUS,
    SANDBOX_GITNEXUS_REGISTRY,
    SANDBOX_HOME,
    SANDBOX_MCP_SOCKET,
    SANDBOX_NODE,
    SANDBOX_TMP,
    SANDBOX_WORKSPACE,
    ReadOnlyMount,
    SandboxError,
    bwrap_base_args,
)


def serve_stdio(
    endpoint: Path, failure: Path, command: Sequence[str], *,
    ready: threading.Event, stop: threading.Event, require_pid_namespace: bool = True,
) -> None:
    """Run one managed server per connection to the cell's private socket."""
    try:
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(endpoint))
            endpoint.chmod(0o600)
            listener.listen(1)
            listener.settimeout(0.1)
            ready.set()
            while not stop.is_set():
                try:
                    connection, _ = listener.accept()
                except TimeoutError:
                    continue
                with connection:
                    try:
                        result = run_managed(
                            command, timeout=24 * 60 * 60, stdio_socket=connection, cancel_event=stop,
                            require_pid_namespace=require_pid_namespace,
                            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
                        )
                        if result.state == "cancelled" and stop.is_set():
                            return
                        if not result.ok:
                            raise RuntimeError(f"MCP server exited with status {result.returncode} ({result.state})")
                        try:
                            pending = connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT)
                        except BlockingIOError:
                            pending = b"client still connected"
                        except ConnectionResetError:
                            pending = b""
                        if pending:
                            raise RuntimeError("MCP server exited before client EOF")
                    except Exception as exc:
                        # Persist failure before EOF lets the client finish its cell.
                        failure.write_text(f"{type(exc).__name__}: {exc}")
                        raise
    except Exception as exc:
        failure.write_text(f"{type(exc).__name__}: {exc}")
        raise


def server_command(*, clone: Path, mounts: Sequence[ReadOnlyMount], bwrap_bin: Path) -> list[str]:
    """Build the credential-free sibling server from host-validated inputs."""
    node = Path(shutil.which("node") or "/usr/bin/node").resolve()
    command = [str(bwrap_bin), *bwrap_base_args(unshare_network=True, cap_drop_all=True),
               "--ro-bind", str(clone), SANDBOX_WORKSPACE,
               "--ro-bind", str(node), SANDBOX_NODE]
    for mount in mounts:
        command += ["--ro-bind", str(mount.source), mount.target]
    command += ["--tmpfs", "/run", "--tmpfs", SANDBOX_TMP,
                "--tmpfs", "/home", "--dir", SANDBOX_HOME, "--clearenv"]
    environment = {
        "HOME": SANDBOX_HOME, "TMPDIR": SANDBOX_TMP,
        "GITNEXUS_HOME": SANDBOX_GITNEXUS_REGISTRY,
        "GITNEXUS_MCP_ALLOWED_REPOS": SANDBOX_WORKSPACE,
        "GITNEXUS_MCP_DEFAULT_REPO": SANDBOX_WORKSPACE,
        "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
        "GIT_TERMINAL_PROMPT": "0",
    }
    for key, value in environment.items():
        command += ["--setenv", key, value]
    return [*command, "--chdir", SANDBOX_WORKSPACE, "--", SANDBOX_NODE,
            f"{SANDBOX_GITNEXUS}/dist/cli/index.js", "mcp"]


def connector_config() -> str:
    # socat's default half-close grace is 0.5s. Give the final response the
    # same window as the CLI client when a caller closes stdin after a request.
    return json.dumps({"mcpServers": {"gitnexus": {
        "type": "stdio", "command": "/usr/bin/socat",
        "args": ["-t", "600", "STDIO", f"UNIX-CONNECT:{SANDBOX_MCP_SOCKET}"],
    }}}, sort_keys=True, separators=(",", ":"))


@contextmanager
def isolated_mcp(*, clone: Path, mounts: Sequence[ReadOnlyMount], bwrap_bin: Path) -> Iterator[ReadOnlyMount]:
    """Own the socket and every server until the complete model session ends."""
    command = server_command(clone=clone, mounts=mounts, bwrap_bin=bwrap_bin)
    # A short, private host path also stays below Linux's Unix-socket path limit.
    with ExitStack() as cleanup:
        root = Path(tempfile.mkdtemp(prefix="wf-mcp-"))
        endpoint, failure = root / "mcp.sock", root / "failure"
        ready, stop = threading.Event(), threading.Event()
        errors: list[Exception] = []

        def run() -> None:
            try:
                serve_stdio(endpoint, failure, command, ready=ready, stop=stop)
            except Exception as exc:
                errors.append(exc)
            finally:
                ready.set()

        worker = threading.Thread(target=run, name="mcp-transport", daemon=True)
        cleanup.callback(lambda: shutil.rmtree(root) if not worker.is_alive() else None)

        def stop_server(_type, primary, _trace) -> None:
            stopped_early = not worker.is_alive()
            stop.set()
            worker.join(timeout=15)
            error = None
            if worker.is_alive():
                error = f"MCP transport supervisor did not stop; backing paths retained at {root}"
            elif failure.exists():
                error = f"MCP transport failed: {failure.read_text()}"
            elif errors:
                error = f"MCP transport supervision failed: {errors!r}"
            elif stopped_early:
                error = "MCP transport stopped before its model session finished"
            if error:
                if primary is None:
                    raise SandboxError(error)
                primary.add_note(error)

        worker.start()
        cleanup.push(stop_server)
        if not ready.wait(10) or not worker.is_alive() or errors:
            raise SandboxError(f"MCP transport failed to start: {errors!r}")
        yield ReadOnlyMount(endpoint, SANDBOX_MCP_SOCKET)
