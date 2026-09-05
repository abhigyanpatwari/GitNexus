"""Process-tree ownership contracts for the workflow benchmark harness."""

from __future__ import annotations

import io
import os
import signal
import sys
import time
import threading
import subprocess
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from workflow_bench import process_control
from workflow_bench.process_control import (
    MAX_TAIL_BYTES,
    ManagedProcessResult,
    mark_cleanup_failure,
    run_managed,
)


PYTHON = sys.executable


def test_cancel_before_spawn_never_starts_the_child(tmp_path):
    event = threading.Event()
    event.set()
    sentinel = tmp_path / "spawned"
    result = run_managed([PYTHON, "-c", f"open({str(sentinel)!r}, 'w').close()"], timeout=60, cancel_event=event)
    assert result.state == "cancelled"
    assert not sentinel.exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX signal escalation")
def test_cancel_after_spawn_kills_a_term_ignoring_child():
    event = threading.Event()
    started = time.monotonic()
    result = run_managed(
        [
            PYTHON,
            "-c",
            "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready',flush=True); time.sleep(60)",
        ],
        timeout=60,
        terminate_grace=0.1,
        cancel_event=event,
        stdout_observer=lambda chunk: event.set() if b"ready" in chunk else None,
    )
    assert result.state == "cancelled" and result.forced_kill
    assert not result.timed_out
    assert time.monotonic() - started < 5


@pytest.mark.skipif(os.name == "nt", reason="POSIX parent signals")
@pytest.mark.parametrize("signum", [signal.SIGINT, signal.SIGTERM])
def test_signal_cancels_active_wave_before_assets_are_released(tmp_path, signum):
    ready = tmp_path / "child-pid"
    assets = tmp_path / "assets"
    assets.write_text("shared")
    command = (
        f"import os,time; from pathlib import Path; Path({str(ready)!r}).write_text(str(os.getpid())); time.sleep(60)"
    )
    script = f"""
import json,sys
from pathlib import Path
from workflow_bench.process_control import cancellation_scope, run_managed
from workflow_bench.runner import sweep_task_cells
rows=[]
def run(index, arm):
    if index == 0:
        return {{'resolved': True, 'error_kind': None}}
    result=run_managed([sys.executable, '-c', {command!r}], timeout=60)
    assert Path({str(assets)!r}).exists(), 'assets removed while a worker was active'
    return {{'resolved': False, 'error_kind': result.state}}
with cancellation_scope(handle_signals=True) as event:
    streak, stopped=sweep_task_cells([(i, 'review') for i in range(10)], workers=2, run=run,
        on_start=lambda *args: None, on_record=lambda i,a,r: rows.append([i,r]),
        outage_streak=0, outage_limit=5, cancel_event=event)
Path({str(assets)!r}).unlink()
print(json.dumps({{'rows': rows, 'stopped': stopped}}))
"""
    process = subprocess.Popen(
        [PYTHON, "-c", script],
        cwd=Path(__file__).resolve().parents[1],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        assert ready.exists()
        child_pid = int(ready.read_text())
        started = time.monotonic()
        process.send_signal(signum)
        stdout, stderr = process.communicate(timeout=15)
        assert process.returncode == 0, stderr
        assert time.monotonic() - started < 15
        report = json.loads(stdout)
        assert report["stopped"] and [row[0] for row in report["rows"]] == [0, 1]
        assert report["rows"][0][1]["resolved"] is True
        assert report["rows"][1][1]["error_kind"] == "cancelled"
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)
        assert not assets.exists()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        if ready.exists():
            try:
                os.killpg(int(ready.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_managed_process_captures_normal_exit() -> None:
    result = run_managed(
        [PYTHON, "-c", "import sys; print('out'); print('err', file=sys.stderr)"],
        timeout=5,
    )

    assert result.state == "exited"
    assert result.returncode == 0
    assert result.stdout_tail.strip() == "out"
    assert result.stderr_tail.strip() == "err"
    assert not result.timed_out


@pytest.mark.skipif(os.name == "nt", reason="POSIX process-group canary")
def test_timeout_kills_term_ignoring_descendants_before_they_write(tmp_path: Path) -> None:
    sentinel = tmp_path / "late-write"
    script = """
import os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
subprocess.Popen([
    sys.executable, '-c',
    "import signal,time,pathlib; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(1); pathlib.Path(%r).write_text('escaped')"
])
while True:
    print('still-running', flush=True)
    time.sleep(0.01)
""" % str(sentinel)

    result = run_managed(
        [PYTHON, "-c", script],
        timeout=0.15,
        terminate_grace=0.1,
    )
    time.sleep(1.1)

    assert result.state == "forced-kill"
    assert result.timed_out
    assert result.forced_kill
    assert not sentinel.exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX cooperative-TERM canary")
def test_timeout_reports_cooperative_term_without_false_forced_kill() -> None:
    started = time.monotonic()
    result = run_managed(
        [PYTHON, "-c", "import time; time.sleep(10)"],
        timeout=0.15,
        terminate_grace=0.8,
    )

    assert result.state == "timeout"
    assert result.timed_out
    assert not result.forced_kill
    assert result.returncode == -15
    assert time.monotonic() - started < 0.6


def test_stdout_and_stderr_are_bounded_while_the_process_runs() -> None:
    script = """\
import os
for _ in range(40):
    os.write(1, b'o' * 8192)
    os.write(2, b'e' * 8192)
os.write(1, b'OUT-END')
os.write(2, b'ERR-END')
"""
    result = run_managed([PYTHON, "-c", script], timeout=5)

    assert result.state == "exited"
    assert len(result.stdout_tail.encode()) <= MAX_TAIL_BYTES
    assert len(result.stderr_tail.encode()) <= MAX_TAIL_BYTES
    assert result.stdout_tail.endswith("OUT-END")
    assert result.stderr_tail.endswith("ERR-END")


def test_parent_can_capture_one_complete_bounded_stdout_stream() -> None:
    payload = b"event-one\nevent-two\n"
    result = run_managed(
        [PYTHON, "-c", f"import os; os.write(1, {payload!r})"],
        timeout=5,
        capture_stdout_bytes=len(payload),
    )

    assert result.ok
    assert result.stdout_capture == payload
    assert result.stdout_capture_overflow is False


def test_parent_stdout_capture_reports_overflow_without_stopping_drain() -> None:
    result = run_managed(
        [PYTHON, "-c", "import os; os.write(1, b'x' * 1024); os.write(1, b'END')"],
        timeout=5,
        capture_stdout_bytes=64,
    )

    assert result.ok
    assert result.stdout_capture == b"x" * 64
    assert result.stdout_capture_overflow is True
    assert result.stdout_tail.endswith("END")


def test_echo_stdout_streams_child_progress_and_stays_off_by_default(capfd) -> None:
    command = [PYTHON, "-c", "import os; os.write(1, b'[task][arm][run 0] starting\\n')"]

    quiet = run_managed(command, timeout=5)
    assert quiet.ok
    assert "starting" not in capfd.readouterr().err

    echoed = run_managed(command, timeout=5, echo_stdout=True)
    assert echoed.ok
    captured = capfd.readouterr()
    assert "[task][arm][run 0] starting" in captured.err
    # Echoing is a passthrough, not a redirect: the tail stays intact for the
    # caller that reports it after the process ends.
    assert "starting" in echoed.stdout_tail


def test_echo_reaches_the_log_while_the_child_is_still_running(tmp_path: Path, monkeypatch) -> None:
    """Streaming has to be prompt, not merely eventual.

    A sweep emits one line every ~45 minutes. Draining with `read(8192)` still
    delivers every byte, so the tail and the capture look correct — but nothing
    surfaces until the pipe closes, which turns a 15-hour job into a silent one
    and is the whole reason this passthrough exists.

    The child here refuses to exit until the echoed line has been observed, so
    an implementation that only flushes at EOF deadlocks and fails on the
    timeout rather than passing on a technicality.
    """
    released = tmp_path / "echo-observed"

    class Sink:
        def write(self, data: bytes) -> int:
            if b"first-line" in data:
                released.write_text("go")
            return len(data)

        def flush(self) -> None:
            pass

    monkeypatch.setattr(process_control.sys, "stderr", SimpleNamespace(buffer=Sink()))
    script = """
import pathlib, sys, time
sys.stdout.write('first-line\\n')
sys.stdout.flush()
target = pathlib.Path(%r)
for _ in range(400):
    if target.exists():
        break
    time.sleep(0.05)
""" % str(released)

    result = run_managed([PYTHON, "-c", script], timeout=15, echo_stdout=True)

    assert released.exists(), "the line never reached the echo sink while the child ran"
    assert result.ok
    assert "first-line" in result.stdout_tail


def test_incomplete_stdin_delivery_cannot_report_success() -> None:
    result = run_managed(
        [PYTHON, "-c", "import os,time; os.close(0); time.sleep(0.05)"],
        timeout=5,
        stdin_data=b"x" * (4 * 1024 * 1024),
    )

    assert result.returncode == 0
    assert result.state == "input-failure"
    assert not result.ok
    assert "stdin write failed" in (result.detail or "")


@pytest.mark.skipif(os.name == "nt", reason="POSIX inherited-pipe canary")
def test_exited_parent_cannot_leave_an_inherited_pipe_descendant(tmp_path: Path) -> None:
    sentinel = tmp_path / "orphan-write"
    child = (
        "import subprocess,sys; "
        f"subprocess.Popen([sys.executable,'-c',\"import time,pathlib;time.sleep(2);pathlib.Path({str(sentinel)!r}).touch()\"]); "
        "print('parent-done')"
    )

    result = run_managed([PYTHON, "-c", child], timeout=5, terminate_grace=0.1)
    time.sleep(2.1)

    assert result.state == "forced-kill"
    assert result.forced_kill
    assert not sentinel.exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX process-group canary")
def test_exited_parent_cannot_leave_a_quiet_descendant(tmp_path: Path) -> None:
    sentinel = tmp_path / "quiet-orphan-write"
    child = (
        "import subprocess,sys; "
        f"subprocess.Popen([sys.executable,'-c',\"import time,pathlib;time.sleep(1);pathlib.Path({str(sentinel)!r}).touch()\"], "
        "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
        "print('parent-done')"
    )

    result = run_managed([PYTHON, "-c", child], timeout=5, terminate_grace=0.1)
    time.sleep(1.1)

    assert result.state == "forced-kill"
    assert result.forced_kill
    assert not sentinel.exists()


def test_required_pid_namespace_fails_before_plain_command_starts(tmp_path: Path) -> None:
    sentinel = tmp_path / "started"

    result = run_managed(
        [PYTHON, "-c", f"from pathlib import Path; Path({str(sentinel)!r}).touch()"],
        timeout=5,
        require_pid_namespace=True,
    )

    assert result.state == "ownership-failure"
    assert result.returncode is None
    assert not sentinel.exists()


def test_cleanup_failure_preserves_the_primary_process_state() -> None:
    primary = ManagedProcessResult(
        state="forced-kill",
        returncode=-9,
        stdout_tail="out",
        stderr_tail="err",
        duration_s=1.0,
        timed_out=True,
        forced_kill=True,
    )

    combined = mark_cleanup_failure(primary, OSError("clone busy"))

    assert combined.state == "cleanup-failure"
    assert combined.primary_state == "forced-kill"
    assert "clone busy" in (combined.detail or "")
    assert combined.stdout_tail == "out"


def test_keyboard_interrupt_reaps_owned_process_and_propagates(monkeypatch) -> None:
    class FakeJob:
        def __init__(self) -> None:
            self.terminated = False
            self.closed = False

        def terminate(self) -> None:
            self.terminated = True

        def close(self) -> None:
            self.closed = True

    class InterruptingProcess:
        pid = 424242
        returncode = None
        stdin = None
        stdout = io.BytesIO()
        stderr = io.BytesIO()

        def __init__(self) -> None:
            self.waits = 0
            self.killed = False

        def wait(self, timeout=None):
            self.waits += 1
            if self.waits == 1:
                raise KeyboardInterrupt
            self.returncode = -9
            return self.returncode

        def kill(self) -> None:
            self.killed = True

    process = InterruptingProcess()
    job = FakeJob() if os.name == "nt" else None
    killed_groups: list[tuple[int, int]] = []
    monkeypatch.setattr(
        "workflow_bench.process_control._spawn",
        lambda *_args, **_kwargs: (
            process,
            job,
            "windows-job" if os.name == "nt" else "posix-process-group",
        ),
    )
    if os.name != "nt":
        monkeypatch.setattr(
            "workflow_bench.process_control.os.killpg",
            lambda pgid, sig: killed_groups.append((pgid, sig)),
        )

    with pytest.raises(KeyboardInterrupt):
        run_managed([PYTHON, "-c", "pass"], timeout=5)

    if job is not None:
        assert job.terminated
        assert job.closed
    else:
        assert killed_groups == [(process.pid, 9)]
    assert process.waits == 2


def test_pre_wait_keyboard_interrupt_reaps_owned_process_and_propagates(monkeypatch) -> None:
    class FakeJob:
        def __init__(self) -> None:
            self.terminated = False
            self.closed = False

        def terminate(self) -> None:
            self.terminated = True

        def close(self) -> None:
            self.closed = True

    class SpawnedProcess:
        pid = 434343
        returncode = None
        stdin = None
        stdout = io.BytesIO()
        stderr = io.BytesIO()

        def __init__(self) -> None:
            self.waits = 0
            self.killed = False

        def wait(self, timeout=None):
            self.waits += 1
            self.returncode = -9
            return self.returncode

        def kill(self) -> None:
            self.killed = True

    process = SpawnedProcess()
    job = FakeJob() if os.name == "nt" else None
    killed_groups: list[tuple[int, int]] = []
    monkeypatch.setattr(
        "workflow_bench.process_control._spawn",
        lambda *_args, **_kwargs: (
            process,
            job,
            "windows-job" if os.name == "nt" else "posix-process-group",
        ),
    )
    monkeypatch.setattr(
        "workflow_bench.process_control.threading.Thread",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(KeyboardInterrupt()),
    )
    if os.name != "nt":
        monkeypatch.setattr(
            "workflow_bench.process_control.os.killpg",
            lambda pgid, sig: killed_groups.append((pgid, sig)),
        )

    with pytest.raises(KeyboardInterrupt):
        run_managed([PYTHON, "-c", "pass"], timeout=5)

    if job is not None:
        assert job.terminated
        assert job.closed
    else:
        assert killed_groups == [(process.pid, signal.SIGKILL)]
    assert process.waits == 1
    assert process.stdout.closed
    assert process.stderr.closed


@pytest.mark.skipif(os.name == "nt", reason="POSIX Popen registration path")
def test_interrupt_after_spawn_return_uses_internal_ownership_registration(monkeypatch) -> None:
    class SpawnedProcess:
        pid = 444444
        returncode = None
        stdin = None
        stdout = io.BytesIO()
        stderr = io.BytesIO()

        def __init__(self) -> None:
            self.waits = 0

        def wait(self, timeout=None):
            self.waits += 1
            self.returncode = -9
            return self.returncode

        def kill(self) -> None:
            self.returncode = -9

    process = SpawnedProcess()
    killed_groups: list[tuple[int, int]] = []
    real_spawn = process_control._spawn

    def interrupt_after_registered_spawn(*args, **kwargs):
        real_spawn(*args, **kwargs)
        raise KeyboardInterrupt

    monkeypatch.setattr(process_control.subprocess, "Popen", lambda *_args, **_kwargs: process)
    monkeypatch.setattr(process_control, "_spawn", interrupt_after_registered_spawn)
    monkeypatch.setattr(process_control.os, "killpg", lambda pgid, sig: killed_groups.append((pgid, sig)))

    with pytest.raises(KeyboardInterrupt):
        run_managed([PYTHON, "-c", "pass"], timeout=5)

    assert killed_groups == [(process.pid, signal.SIGKILL)]
    assert process.waits == 1
    assert process.stdout.closed
    assert process.stderr.closed


def test_post_wait_keyboard_interrupt_reaps_job_and_propagates(monkeypatch) -> None:
    class CompletedProcess:
        pid = 515151
        returncode = None
        stdin = None
        stdout = io.BytesIO()
        stderr = io.BytesIO()

        def __init__(self) -> None:
            self.waits = 0

        def wait(self, timeout=None):
            self.waits += 1
            self.returncode = 0 if self.waits == 1 else -9
            return self.returncode

        def kill(self) -> None:
            self.returncode = -9

    class InterruptingJob:
        def __init__(self) -> None:
            self.terminated = False
            self.closed = False

        def active_processes(self) -> int:
            raise KeyboardInterrupt

        def terminate(self) -> None:
            self.terminated = True

        def close(self) -> None:
            self.closed = True

    process = CompletedProcess()
    job = InterruptingJob()
    monkeypatch.setattr(
        "workflow_bench.process_control._spawn",
        lambda *_args, **_kwargs: (process, job, "windows-job"),
    )

    with pytest.raises(KeyboardInterrupt):
        run_managed([PYTHON, "-c", "pass"], timeout=5)

    assert job.terminated
    assert job.closed
    assert process.waits == 2


@pytest.mark.skipif(os.name != "nt", reason="native Windows Job Object canary")
def test_windows_job_kills_grandchild_before_delayed_write(tmp_path: Path) -> None:
    sentinel = tmp_path / "late-write"
    child = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable,'-c',\"import time,pathlib;time.sleep(1);pathlib.Path({str(sentinel)!r}).touch()\"]); "
        "time.sleep(10)"
    )

    result = run_managed([PYTHON, "-c", child], timeout=0.15, terminate_grace=0.1)
    time.sleep(1.1)

    assert result.state == "forced-kill"
    assert result.ownership == "windows-job"
    assert not sentinel.exists()


@pytest.mark.skipif(os.name != "nt", reason="native Windows Job Object canary")
def test_windows_normal_parent_with_grandchild_is_not_successful_evidence(tmp_path: Path) -> None:
    sentinel = tmp_path / "quiet-late-write"
    parent = (
        "import subprocess,sys; "
        f"subprocess.Popen([sys.executable,'-c',\"import time,pathlib;time.sleep(1);pathlib.Path({str(sentinel)!r}).touch()\"], "
        "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)"
    )

    result = run_managed([PYTHON, "-c", parent], timeout=5, terminate_grace=0.1)
    time.sleep(1.1)

    assert result.state == "forced-kill"
    assert result.forced_kill
    assert not result.ok
    assert not sentinel.exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX process-group ownership canary")
def test_concurrent_cells_reap_only_their_own_process_tree(tmp_path: Path) -> None:
    """One cell timing out must not touch a sibling cell running beside it.

    `run_managed` reaps by process group. Cells only ever ran one at a time
    before, so nothing exercised what happens when a `killpg` fires while other
    owned trees are alive — a leaked or shared pgid would take the siblings
    down with it, and the sweep would read that as two more excluded runs.
    """
    survivor_sentinel = tmp_path / "survivor-finished"
    victim_sentinel = tmp_path / "victim-escaped"

    # Each cell spawns a descendant, like a sandboxed session does.
    survivor = """
import pathlib, subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', "import time; time.sleep(2)"])
time.sleep(1.0)
pathlib.Path(%r).write_text('finished')
child.wait()
print('survivor-done', flush=True)
""" % str(survivor_sentinel)
    victim = """
import pathlib, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
subprocess.Popen([
    sys.executable, '-c',
    "import signal,time,pathlib; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(1.5); pathlib.Path(%r).write_text('escaped')"
])
while True:
    time.sleep(0.01)
""" % str(victim_sentinel)

    def cell(source: str, timeout: float):
        return run_managed([PYTHON, "-c", source], timeout=timeout, terminate_grace=0.1)

    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [
            pool.submit(cell, survivor, 10.0),
            pool.submit(cell, victim, 0.2),
            pool.submit(cell, survivor, 10.0),
        ]
        first, doomed, second = (future.result() for future in futures)

    time.sleep(1.8)

    assert doomed.state == "forced-kill"
    assert not victim_sentinel.exists(), "the timed-out cell leaked a descendant"
    # The siblings were mid-flight when the killpg fired.
    assert first.ok and second.ok
    assert "survivor-done" in first.stdout_tail
    assert "survivor-done" in second.stdout_tail
    assert survivor_sentinel.exists()
