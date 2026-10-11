"""Run the actual CLI with a real PTY; mutate fixtures only after its prompt."""
import errno
import json
import os
import pty
import select
import subprocess
import sys
import termios
import time

config = json.load(sys.stdin)
master, slave = pty.openpty()
attrs = termios.tcgetattr(slave)
attrs[3] &= ~termios.ECHO
termios.tcsetattr(slave, termios.TCSANOW, attrs)
child = subprocess.Popen(config["argv"], cwd=config["cwd"], stdin=slave,
                         stdout=subprocess.PIPE if config.get("pipe_output") else slave,
                         stderr=slave, start_new_session=True)
os.close(slave)
output = bytearray()
answered = 0
deadline = time.monotonic() + 20
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            output.extend(data)
            while output.count(b"Choice [x]: ") > answered:
                steps = config.get("steps", [])
                step = steps[answered] if answered < len(steps) else {"choice": "EOF"}
                for mutation in step.get("writes", []):
                    with open(mutation["file"], "w", encoding="utf-8") as target:
                        target.write(mutation["content"])
                choice = step.get("choice", "EOF")
                os.write(master, b"\x04" if choice == "EOF" else (choice + "\n").encode())
                answered += 1
        if child.poll() is not None:
            # Continue draining the PTY until EIO, including the final decision.
            continue
    else:
        child.kill()
        raise TimeoutError("CLI did not finish within the PTY driver's deadline")
    code = child.wait(timeout=2)
    if child.stdout is not None:
        output.extend(child.stdout.read())
    print(json.dumps({"code": code, "output": output.decode("utf-8"), "prompts": answered}))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
