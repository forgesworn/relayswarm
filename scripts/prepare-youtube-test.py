#!/usr/bin/env python3
"""Save a private test-forwarding URL without exposing the stream key."""

import argparse
import getpass
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path.home() / ".config" / "relayswarm" / "youtube-test-url")
    args = parser.parse_args()
    destination = args.output.expanduser().absolute()
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    for parent in (destination.parent, *destination.parent.parents):
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022:
            raise SystemExit("Use an owner-controlled path without symbolic links or writable ancestor directories.")
    parent_info = destination.parent.stat()
    if parent_info.st_uid != os.getuid() or stat.S_IMODE(parent_info.st_mode) != 0o700:
        raise SystemExit("The destination directory must belong to you and have mode 0700.")
    server = input("YouTube RTMPS server address (no stream key): ").strip()
    parsed = urlsplit(server)
    if (parsed.scheme != "rtmps" or parsed.hostname not in {"a.rtmps.youtube.com", "b.rtmps.youtube.com"}
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.port not in {None, 443} or parsed.path.rstrip("/") != "/live2"):
        raise SystemExit("Use the RTMPS server address shown for the private YouTube test stream.")
    key = getpass.getpass("Test stream key (hidden): ").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,256}", key):
        raise SystemExit("Invalid stream-key format; nothing was written.")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(destination, flags, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.write(server.rstrip("/") + "/" + key + "\n")
        output.flush()
        os.fsync(output.fileno())
    print(f"Private forwarding file saved: {destination}")
    print("Only send the file path and the private broadcast watch URL to the agent.")


if __name__ == "__main__":
    main()
