"""Per-cell stdio endpoint; candidate runtime files stay outside the agent."""

from __future__ import annotations

import json
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Iterator, Sequence

from .process_control import ManagedProcessResult, run_managed
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
    pid_namespace_command,
)

def serve_stdio(endpoint: Path, failure: Path, command: Sequence[str]) -> None:
    """Connect each client socket directly to one server's stdin/stdout.

    The trusted owner runs in an owned PID namespace. The command establishes
    the candidate's separate filesystem, network and process boundaries.
    No MCP parsing, shell expansion, or concurrent server fan-out happens here.
    """
    try:
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(endpoint))
            endpoint.chmod(0o600)
            listener.listen(1)
            print("ready", flush=True)
            while True:
                connection, _ = listener.accept()
                with connection:
                    try:
                        with subprocess.Popen(
                            command, stdin=connection, stdout=connection, close_fds=True,
                        ) as server:
                            returncode = server.wait()
                        if returncode:
                            raise RuntimeError(f"MCP server exited with status {returncode}")
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
    return json.dumps({"mcpServers": {"gitnexus": {
        "type": "stdio", "command": "/usr/bin/socat",
        "args": ["STDIO", f"UNIX-CONNECT:{SANDBOX_MCP_SOCKET}"],
    }}}, sort_keys=True, separators=(",", ":"))


@contextmanager
def isolated_mcp(*, clone: Path, mounts: Sequence[ReadOnlyMount], bwrap_bin: Path) -> Iterator[ReadOnlyMount]:
    """Own the socket and every server until the complete model session ends."""
    # A short, private host path also stays below Linux's Unix-socket path limit.
    with ExitStack() as cleanup:
        root = Path(tempfile.mkdtemp(prefix="wf-mcp-"))
        endpoint, failure = root / "mcp.sock", root / "failure"
        ready, stop = threading.Event(), threading.Event()
        outcomes: list[ManagedProcessResult | BaseException] = []
        command = pid_namespace_command([
            sys.executable, "-m", "workflow_bench.mcp_transport", str(endpoint), str(failure),
            *server_command(clone=clone, mounts=mounts, bwrap_bin=bwrap_bin),
        ], bwrap_bin=bwrap_bin)

        def run() -> None:
            try:
                outcomes.append(run_managed(
                    command, timeout=24 * 60 * 60, require_pid_namespace=True,
                    env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
                         "PYTHONPATH": str(Path(__file__).resolve().parent.parent)},
                    cancel_event=stop, stdout_observer=lambda _chunk: ready.set(),
                ))
            except BaseException as exc:
                outcomes.append(exc)
            finally:
                ready.set()

        worker = threading.Thread(target=run, name="mcp-transport", daemon=True)
        cleanup.callback(lambda: shutil.rmtree(root) if not worker.is_alive() else None)
        worker.start()
        primary: BaseException | None = None
        try:
            if not ready.wait(10) or not endpoint.exists() or outcomes:
                raise SandboxError(f"MCP transport failed to start: {outcomes!r}")
            yield ReadOnlyMount(endpoint, SANDBOX_MCP_SOCKET)
            if outcomes or failure.exists():
                raise SandboxError(f"MCP transport failed: {failure.read_text() if failure.exists() else outcomes!r}")
        except BaseException as exc:
            primary = exc
            raise
        finally:
            stop.set()
            worker.join(timeout=15)
            error = None
            if worker.is_alive():
                error = f"MCP transport supervisor did not stop; backing paths retained at {root}"
            elif failure.exists():
                error = f"MCP transport failed: {failure.read_text()}"
            elif not outcomes or isinstance(outcomes[0], BaseException):
                error = f"MCP transport supervision failed: {outcomes!r}"
            elif outcomes[0].state not in ("cancelled",):
                error = f"MCP transport exited unexpectedly: {outcomes[0]!r}"
            if error:
                if primary is None:
                    raise SandboxError(error)
                primary.add_note(error)


if __name__ == "__main__":
    serve_stdio(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:])
