"""PID 1 for a single evaluator-owned OCI worker."""

import os
import selectors
import socket
import subprocess
import sys


def main() -> int:
    if os.getpid() != 1:
        raise RuntimeError("the evaluator worker requires a private PID namespace")
    with socket.socket(socket.AF_UNIX) as owner, selectors.DefaultSelector() as ready:
        owner.connect("/run/gnx-owner.sock")
        ready.register(owner, selectors.EVENT_READ)
        child = subprocess.Popen(sys.argv[1:], close_fds=True)
        pidfd = os.pidfd_open(child.pid)
        try:
            ready.register(pidfd, selectors.EVENT_READ)
            if any(key.fileobj is owner for key, _ in ready.select()):
                # Exiting PID 1 ends every process in this worker, including
                # descendants that started another process group or session.
                return 125
            status = child.wait()
            code = 128 - status if status < 0 else status
            owner.sendall(bytes([code]))
            return code
        finally:
            os.close(pidfd)


if __name__ == "__main__":
    sys.exit(main())
