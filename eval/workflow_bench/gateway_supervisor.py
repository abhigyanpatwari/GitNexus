"""Private gateway owner. EOF on stdin means the harness no longer exists.

Executed by absolute script path so the isolated gateway environment needs no
PYTHONPATH. The gateway receives DEVNULL, never the owner-liveness descriptor.
"""

from __future__ import annotations

import signal
import sys
import threading

from process_control import run_managed


def main() -> int:
    cancelled = threading.Event()

    def watch_owner() -> None:
        try:
            sys.stdin.buffer.read(1)
        finally:
            cancelled.set()

    threading.Thread(target=watch_owner, daemon=True).start()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: cancelled.set())
    result = run_managed(
        sys.argv[1:],
        timeout=7 * 24 * 60 * 60,
        cancel_event=cancelled,
        echo_stdout=True,
    )
    if result.stderr_tail:
        print(result.stderr_tail, file=sys.stderr, flush=True)
    if result.detail:
        print(result.detail, file=sys.stderr, flush=True)
    return 0 if result.ok or result.state == "cancelled" else 1


if __name__ == "__main__":
    raise SystemExit(main())
