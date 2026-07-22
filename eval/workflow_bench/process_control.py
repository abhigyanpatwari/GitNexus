"""Bounded, owned subprocess execution for the workflow benchmark.

The benchmark runs model sessions and task-authored commands that may create
descendants.  ``subprocess.run(..., timeout=...)`` kills only the immediate
process and buffers output without a bound, so it is not an ownership boundary.
This module centralizes the lifecycle and makes every terminal state explicit.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import BinaryIO, Literal


MAX_TAIL_BYTES = 64 * 1024
DEFAULT_TERMINATE_GRACE = 5.0

ProcessState = Literal[
    "exited",
    "input-failure",
    "timeout",
    "forced-kill",
    "ownership-failure",
    "spawn-failure",
    "reap-failure",
    "cleanup-failure",
]


@dataclass(frozen=True)
class ManagedProcessResult:
    """Complete, bounded evidence for one owned process tree."""

    state: ProcessState
    returncode: int | None
    stdout_tail: str
    stderr_tail: str
    duration_s: float
    timed_out: bool = False
    forced_kill: bool = False
    ownership: str | None = None
    detail: str | None = None
    primary_state: ProcessState | None = None
    # Complete parent-captured stdout for callers that explicitly request a
    # bounded evidence stream.  Unlike files under the child HOME, these bytes
    # never enter the child's mount namespace and therefore cannot be forged by
    # an agent-launched tool.
    stdout_capture: bytes | None = None
    stdout_capture_overflow: bool = False

    @property
    def ok(self) -> bool:
        return self.state == "exited" and self.returncode == 0


class ManagedProcessError(RuntimeError):
    """Raised by ``run_checked`` while preserving the terminal evidence."""

    def __init__(self, command: Sequence[str] | str, result: ManagedProcessResult) -> None:
        self.command = command
        self.result = result
        super().__init__(
            f"managed command failed ({result.state}, exit={result.returncode}): "
            f"{result.detail or result.stderr_tail[-1000:]}"
        )


class _TailBuffer:
    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._value = bytearray()
        self._lock = threading.Lock()

    def append(self, chunk: bytes) -> None:
        if not chunk:
            return
        with self._lock:
            if len(chunk) >= self._limit:
                self._value[:] = chunk[-self._limit :]
                return
            overflow = len(self._value) + len(chunk) - self._limit
            if overflow > 0:
                del self._value[:overflow]
            self._value.extend(chunk)

    def text(self) -> str:
        with self._lock:
            return bytes(self._value).decode(errors="replace")


class _BoundedCapture:
    """Capture a complete byte stream up to a hard limit while still draining."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._value = bytearray()
        self._overflow = False
        self._lock = threading.Lock()

    def append(self, chunk: bytes) -> None:
        if not chunk:
            return
        with self._lock:
            remaining = self._limit - len(self._value)
            if remaining > 0:
                self._value.extend(chunk[:remaining])
            if len(chunk) > remaining:
                self._overflow = True

    def result(self) -> tuple[bytes, bool]:
        with self._lock:
            return bytes(self._value), self._overflow


def _drain(
    pipe: BinaryIO,
    tail: _TailBuffer,
    capture: _BoundedCapture | None = None,
) -> None:
    try:
        while chunk := pipe.read(8192):
            tail.append(chunk)
            if capture is not None:
                capture.append(chunk)
    except (OSError, ValueError):
        # A forced close is part of the reap path. The terminal result records
        # an actual reap failure; a reader seeing the close is not one itself.
        return


def _write_stdin(pipe: BinaryIO, payload: bytes, errors: list[str]) -> None:
    try:
        pipe.write(payload)
        pipe.flush()
    except (BrokenPipeError, OSError, ValueError) as exc:
        errors.append(f"stdin write failed: {type(exc).__name__}: {exc}")
    finally:
        try:
            pipe.close()
        except (OSError, ValueError):
            pass


def _pid_namespace_wrapper(command: Sequence[str] | str, shell: bool) -> bool:
    """Accept only the trusted Bubblewrap ownership shape.

    A process group cannot discover a descendant that calls ``setsid()``.  The
    caller may claim PID-namespace ownership only when the command itself is a
    direct Bubblewrap invocation with the required namespace/lifetime flags.
    """

    if shell or isinstance(command, str) or not command:
        return False
    executable = shutil.which(os.fspath(command[0]))
    if executable is None or Path(executable).name != "bwrap":
        return False
    args = {os.fspath(part) for part in command[1:]}
    return "--unshare-pid" in args and "--die-with-parent" in args


def _group_exists(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # The group exists but ownership is unexpectedly insufficient. Keep
        # the conservative path and attempt the terminating signal.
        return True
    return True


class _WindowsJob:
    """Kill-on-close Job Object assigned before the child resumes."""

    def __init__(
        self,
        process: subprocess.Popen[bytes],
        ownership_slot: list[tuple[subprocess.Popen[bytes], _WindowsJob | None, int | None]],
    ) -> None:
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        ntdll = ctypes.WinDLL("ntdll")
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel32.TerminateJobObject.restype = wintypes.BOOL
        kernel32.QueryInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel32.QueryInformationJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
        ntdll.NtResumeProcess.restype = wintypes.LONG

        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        self._kernel32 = kernel32
        self._handle = handle
        ownership_slot[-1] = (process, self, None)
        try:
            limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            limits.BasicLimitInformation.LimitFlags = 0x00002000  # KILL_ON_JOB_CLOSE
            if not kernel32.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")
            process_handle = wintypes.HANDLE(int(process._handle))  # type: ignore[attr-defined]
            if not kernel32.AssignProcessToJobObject(handle, process_handle):
                raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")
            status = int(ntdll.NtResumeProcess(process_handle))
            if status != 0:
                raise OSError(status, "NtResumeProcess failed")
        except BaseException:
            # The child is still suspended when assignment fails. Kill it
            # before releasing any handle; never retry with job breakaway.
            process.kill()
            process.wait()
            self.close()
            raise

    def terminate(self) -> None:
        import ctypes

        if self._handle and not self._kernel32.TerminateJobObject(self._handle, 1):
            raise OSError(ctypes.get_last_error(), "TerminateJobObject failed")

    def active_processes(self) -> int:
        """Return live members so closing the job cannot hide forced cleanup."""

        import ctypes
        from ctypes import wintypes

        class JOBOBJECT_BASIC_ACCOUNTING_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("TotalUserTime", ctypes.c_longlong),
                ("TotalKernelTime", ctypes.c_longlong),
                ("ThisPeriodTotalUserTime", ctypes.c_longlong),
                ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
                ("TotalPageFaultCount", wintypes.DWORD),
                ("TotalProcesses", wintypes.DWORD),
                ("ActiveProcesses", wintypes.DWORD),
                ("TotalTerminatedProcesses", wintypes.DWORD),
            ]

        info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION()
        returned = wintypes.DWORD()
        if not self._handle or not self._kernel32.QueryInformationJobObject(
            self._handle,
            1,  # JobObjectBasicAccountingInformation
            ctypes.byref(info),
            ctypes.sizeof(info),
            ctypes.byref(returned),
        ):
            raise OSError(ctypes.get_last_error(), "QueryInformationJobObject failed")
        return int(info.ActiveProcesses)

    def close(self) -> None:
        if self._handle:
            self._kernel32.CloseHandle(self._handle)
            self._handle = None


def _spawn(
    command: Sequence[str] | str,
    *,
    cwd: Path | str | None,
    env: Mapping[str, str] | None,
    shell: bool,
    pipe_stdin: bool,
    ownership_slot: list[tuple[subprocess.Popen[bytes], _WindowsJob | None, int | None]],
) -> tuple[subprocess.Popen[bytes], _WindowsJob | None, str]:
    flags = 0
    kwargs: dict[str, object] = {}
    ownership = "posix-process-group"
    if os.name == "nt":
        flags = 0x00000004 | 0x00000200  # CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP
        ownership = "windows-job"
    else:
        kwargs["start_new_session"] = True

    process = None
    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=dict(env) if env is not None else None,
            shell=shell,
            stdin=subprocess.PIPE if pipe_stdin else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=flags,
            **kwargs,
        )
    finally:
        if process is not None:
            ownership_slot.append((process, None, process.pid if os.name != "nt" else None))
    job = None
    if os.name == "nt":
        job = _WindowsJob(process, ownership_slot)
    return process, job, ownership


def _empty_result(state: ProcessState, started: float, detail: str) -> ManagedProcessResult:
    return ManagedProcessResult(
        state=state,
        returncode=None,
        stdout_tail="",
        stderr_tail="",
        duration_s=round(time.monotonic() - started, 3),
        detail=detail,
    )


def _abort_owned_process(
    process: subprocess.Popen[bytes],
    job: _WindowsJob | None,
    owned_pgid: int | None,
) -> None:
    """Best-effort synchronous cleanup while preserving caller cancellation."""

    if getattr(process, "_workflow_bench_abort_started", False):
        return
    setattr(process, "_workflow_bench_abort_started", True)
    try:
        if job is not None:
            job.terminate()
        elif owned_pgid is not None:
            os.killpg(owned_pgid, signal.SIGKILL)
        else:
            process.kill()
    except BaseException:
        try:
            process.kill()
        except BaseException:
            pass
    try:
        process.wait(timeout=1)
    except BaseException:
        pass
    for pipe in (process.stdin, process.stdout, process.stderr):
        if pipe is not None:
            try:
                pipe.close()
            except (OSError, ValueError):
                pass
    if job is not None:
        try:
            job.close()
        except BaseException:
            pass


def _run_managed_inner(
    command: Sequence[str] | str,
    *,
    cwd: Path | str | None = None,
    env: Mapping[str, str] | None = None,
    shell: bool = False,
    timeout: float,
    terminate_grace: float = DEFAULT_TERMINATE_GRACE,
    tail_bytes: int = MAX_TAIL_BYTES,
    require_pid_namespace: bool = False,
    stdin_data: bytes | None = None,
    capture_stdout_bytes: int | None = None,
    _ownership_slot: list[tuple[subprocess.Popen[bytes], _WindowsJob | None, int | None]],
) -> ManagedProcessResult:
    """Implementation registered with an outer post-spawn ownership guard."""

    started = time.monotonic()
    if timeout <= 0 or terminate_grace < 0 or tail_bytes <= 0:
        raise ValueError("timeout and tail_bytes must be positive; terminate_grace must be non-negative")
    if capture_stdout_bytes is not None and capture_stdout_bytes <= 0:
        raise ValueError("capture_stdout_bytes must be positive when supplied")
    if require_pid_namespace:
        if os.name == "nt":
            return _empty_result("ownership-failure", started, "PID-namespace execution is not supported on Windows")
        if not _pid_namespace_wrapper(command, shell):
            return _empty_result(
                "ownership-failure",
                started,
                "required Bubblewrap --unshare-pid/--die-with-parent ownership is absent",
            )

    try:
        process, job, ownership = _spawn(
            command,
            cwd=cwd,
            env=env,
            shell=shell,
            pipe_stdin=stdin_data is not None,
            ownership_slot=_ownership_slot,
        )
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException as exc:
        if _ownership_slot:
            _abort_owned_process(*_ownership_slot[0])
        state: ProcessState = "ownership-failure" if os.name == "nt" else "spawn-failure"
        return _empty_result(state, started, f"{type(exc).__name__}: {exc}")

    owned_pgid = process.pid if os.name != "nt" else None
    if not _ownership_slot:
        # Compatibility for injected test doubles that replace _spawn.
        _ownership_slot.append((process, job, owned_pgid))
    if require_pid_namespace:
        ownership = "bwrap-pid-namespace"
    assert process.stdout is not None and process.stderr is not None
    stdout = _TailBuffer(tail_bytes)
    stderr = _TailBuffer(tail_bytes)
    stdout_capture = _BoundedCapture(capture_stdout_bytes) if capture_stdout_bytes is not None else None
    readers = [
        threading.Thread(target=_drain, args=(process.stdout, stdout, stdout_capture), daemon=True),
        threading.Thread(target=_drain, args=(process.stderr, stderr), daemon=True),
    ]
    for reader in readers:
        reader.start()
    stdin_errors: list[str] = []
    writer = None
    if stdin_data is not None:
        assert process.stdin is not None
        writer = threading.Thread(
            target=_write_stdin,
            args=(process.stdin, stdin_data, stdin_errors),
            daemon=True,
        )
        writer.start()

    state: ProcessState = "exited"
    detail = None
    timed_out = False
    forced_kill = False
    try:
        process.wait(timeout=timeout)
    except (KeyboardInterrupt, SystemExit):
        _abort_owned_process(process, job, owned_pgid)
        raise
    except subprocess.TimeoutExpired:
        timed_out = True
        state = "timeout"
        try:
            if job is not None:
                # Job Object termination is the Windows tree-wide primitive;
                # there is no safe cooperative group signal equivalent.
                job.terminate()
                forced_kill = True
                state = "forced-kill"
            else:
                assert owned_pgid is not None
                pgid = owned_pgid
                os.killpg(pgid, signal.SIGTERM)
                deadline = time.monotonic() + terminate_grace
                while time.monotonic() < deadline and _group_exists(pgid):
                    # Reap an exited group leader while waiting. An unreaped
                    # zombie keeps killpg(..., 0) true and used to make every
                    # cooperative SIGTERM look like a forced SIGKILL.
                    process.poll()
                    if not _group_exists(pgid):
                        break
                    time.sleep(min(0.02, max(0.0, deadline - time.monotonic())))
                if _group_exists(pgid):
                    os.killpg(pgid, signal.SIGKILL)
                    forced_kill = True
                    state = "forced-kill"
            if process.returncode is None:
                process.wait(timeout=max(1.0, terminate_grace))
        except (KeyboardInterrupt, SystemExit):
            _abort_owned_process(process, job, owned_pgid)
            raise
        except BaseException as exc:
            state = "reap-failure"
            detail = f"{type(exc).__name__}: {exc}"
            try:
                process.kill()
                process.wait(timeout=1)
            except BaseException as reap_exc:
                detail += f"; final reap failed: {type(reap_exc).__name__}: {reap_exc}"
    except BaseException as exc:
        # If the parent raises after spawn, ownership still has to terminate
        # before the exception is represented in the result.
        detail = f"parent wait failed: {type(exc).__name__}: {exc}"
        try:
            if job is not None:
                job.terminate()
            else:
                assert owned_pgid is not None
                os.killpg(owned_pgid, signal.SIGKILL)
            process.wait(timeout=1)
            forced_kill = True
            state = "forced-kill"
        except BaseException as reap_exc:
            state = "reap-failure"
            detail += f"; reap failed: {type(reap_exc).__name__}: {reap_exc}"

    # KILL_ON_JOB_CLOSE is real termination, not a successful exit. Inspect
    # membership before closing the handle so a quiet Windows grandchild
    # cannot be killed while the benchmark row remains eligible evidence.
    if state == "exited" and job is not None:
        try:
            if job.active_processes() > 0:
                job.terminate()
                forced_kill = True
                state = "forced-kill"
                detail = "parent exited while Windows Job Object still owned descendants"
        except (KeyboardInterrupt, SystemExit):
            _abort_owned_process(process, job, owned_pgid)
            raise
        except BaseException as exc:
            try:
                job.terminate()
            except BaseException as terminate_exc:
                detail = f"job membership query failed: {exc}; termination failed: {terminate_exc}"
                state = "reap-failure"
            else:
                forced_kill = True
                state = "forced-kill"
                detail = f"job membership query failed; conservatively terminated job: {exc}"

    # A parent can exit successfully after spawning a quiet child that closes
    # every inherited pipe. Pipe draining alone cannot reveal that descendant,
    # so explicitly close the owned POSIX process group before returning.
    try:
        quiet_descendant_exists = state == "exited" and owned_pgid is not None and _group_exists(owned_pgid)
    except (KeyboardInterrupt, SystemExit):
        _abort_owned_process(process, job, owned_pgid)
        raise
    if quiet_descendant_exists:
        try:
            os.killpg(owned_pgid, signal.SIGKILL)
            forced_kill = True
            state = "forced-kill"
        except ProcessLookupError:
            pass
        except (KeyboardInterrupt, SystemExit):
            _abort_owned_process(process, job, owned_pgid)
            raise
        except BaseException as exc:
            state = "reap-failure"
            detail = f"quiet-descendant kill failed: {type(exc).__name__}: {exc}"

    for reader in readers:
        try:
            reader.join(timeout=1.0)
        except (KeyboardInterrupt, SystemExit):
            _abort_owned_process(process, job, owned_pgid)
            raise
    if any(reader.is_alive() for reader in readers):
        # A descendant can outlive an exited parent while holding inherited
        # pipe handles. Treat that as owned work, terminate the tree, then
        # drain again instead of merely closing our side of the pipes.
        try:
            if job is not None:
                job.terminate()
            else:
                assert owned_pgid is not None
                os.killpg(owned_pgid, signal.SIGKILL)
            forced_kill = True
            state = "forced-kill"
        except ProcessLookupError:
            pass
        except (KeyboardInterrupt, SystemExit):
            _abort_owned_process(process, job, owned_pgid)
            raise
        except BaseException as exc:
            state = "reap-failure"
            detail = (detail + "; " if detail else "") + f"pipe-owner kill failed: {exc}"
        for reader in readers:
            try:
                reader.join(timeout=max(1.0, terminate_grace))
            except (KeyboardInterrupt, SystemExit):
                _abort_owned_process(process, job, owned_pgid)
                raise
    if any(reader.is_alive() for reader in readers):
        state = "reap-failure"
        detail = (detail + "; " if detail else "") + "output pipes remained open after tree termination"
        for pipe in (process.stdout, process.stderr):
            try:
                pipe.close()
            except OSError:
                pass
    if writer is not None:
        try:
            writer.join(timeout=1.0)
        except (KeyboardInterrupt, SystemExit):
            _abort_owned_process(process, job, owned_pgid)
            raise
        if writer.is_alive():
            state = "reap-failure"
            stdin_errors.append("stdin writer remained blocked after tree termination")
    if stdin_errors:
        detail = (detail + "; " if detail else "") + "; ".join(stdin_errors)
        if state == "exited":
            state = "input-failure"

    if job is not None:
        try:
            job.close()
        except (KeyboardInterrupt, SystemExit):
            _abort_owned_process(process, job, owned_pgid)
            raise

    captured_stdout, capture_overflow = stdout_capture.result() if stdout_capture is not None else (None, False)
    return ManagedProcessResult(
        state=state,
        returncode=process.returncode,
        stdout_tail=stdout.text(),
        stderr_tail=stderr.text(),
        duration_s=round(time.monotonic() - started, 3),
        timed_out=timed_out,
        forced_kill=forced_kill,
        ownership=ownership,
        detail=detail,
        stdout_capture=captured_stdout,
        stdout_capture_overflow=capture_overflow,
    )


def run_managed(
    command: Sequence[str] | str,
    *,
    cwd: Path | str | None = None,
    env: Mapping[str, str] | None = None,
    shell: bool = False,
    timeout: float,
    terminate_grace: float = DEFAULT_TERMINATE_GRACE,
    tail_bytes: int = MAX_TAIL_BYTES,
    require_pid_namespace: bool = False,
    stdin_data: bytes | None = None,
    capture_stdout_bytes: int | None = None,
) -> ManagedProcessResult:
    """Run one command with bounded output and owned-tree termination."""

    ownership_slot: list[tuple[subprocess.Popen[bytes], _WindowsJob | None, int | None]] = []
    try:
        return _run_managed_inner(
            command,
            cwd=cwd,
            env=env,
            shell=shell,
            timeout=timeout,
            terminate_grace=terminate_grace,
            tail_bytes=tail_bytes,
            require_pid_namespace=require_pid_namespace,
            stdin_data=stdin_data,
            capture_stdout_bytes=capture_stdout_bytes,
            _ownership_slot=ownership_slot,
        )
    except BaseException:
        if ownership_slot:
            _abort_owned_process(*ownership_slot[0])
        raise


def mark_cleanup_failure(result: ManagedProcessResult, error: BaseException) -> ManagedProcessResult:
    """Preserve the primary terminal state when clone cleanup also fails."""

    cleanup = f"{type(error).__name__}: {error}"
    detail = f"{result.detail}; cleanup: {cleanup}" if result.detail else f"cleanup: {cleanup}"
    return replace(
        result,
        state="cleanup-failure",
        primary_state=result.primary_state or result.state,
        detail=detail,
    )


def run_checked(
    command: Sequence[str] | str,
    **kwargs: object,
) -> ManagedProcessResult:
    """Run a managed command and raise with its bounded evidence on failure."""

    result = run_managed(command, **kwargs)  # type: ignore[arg-type]
    if not result.ok:
        raise ManagedProcessError(command, result)
    return result
