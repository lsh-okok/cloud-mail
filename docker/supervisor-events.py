#!/usr/bin/python3
"""Stop the complete runtime when a service exhausts its restart attempts."""
import os
import signal
import sys

while True:
    sys.stdout.write("READY\n")
    sys.stdout.flush()
    header = sys.stdin.readline()
    if not header:
        break
    fields = dict(field.split(":", 1) for field in header.split())
    payload = sys.stdin.read(int(fields["len"]))
    sys.stdout.write("RESULT 2\nOK")
    sys.stdout.flush()
    sys.stderr.write("A runtime service failed repeatedly; shutting down the container: " + payload + "\n")
    sys.stderr.flush()
    os.kill(os.getppid(), signal.SIGTERM)
