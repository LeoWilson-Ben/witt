#!/usr/bin/env python3
"""Private pipe-to-PTY bridge for the official CLI login. Never logs terminal data."""
import os, pty, select, signal, struct, subprocess, sys, termios, fcntl
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 80, 4096, 0, 0))
settings = termios.tcgetattr(slave)
settings[3] &= ~termios.ECHO
termios.tcsetattr(slave, termios.TCSANOW, settings)
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
def stop(*_):
    if child.poll() is None:
        try: os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError: pass
    try: child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        child.wait()
signal.signal(signal.SIGTERM, lambda *_: (stop(), sys.exit(0)))
signal.signal(signal.SIGINT, lambda *_: (stop(), sys.exit(0)))
try:
    while child.poll() is None:
        for stream in select.select([master, sys.stdin.fileno()], [], [], .2)[0]:
            try: chunk = os.read(stream, 16384)
            except OSError: chunk = b''
            if not chunk: stop(); break
            if stream == master:
                sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
            else: os.write(master, chunk)
finally:
    stop(); os.close(master)
sys.exit(child.returncode if child.returncode is not None and child.returncode >= 0 else 1)
