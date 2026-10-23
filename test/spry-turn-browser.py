#!/usr/bin/env python3
"""Run the real HLS/WebRTC harness through an explicitly selected Spry binary."""

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import signal
from pathlib import Path
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent


def run_owned(command, log, timeout):
    process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        return process.wait(timeout=timeout)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spry-repo", type=Path, required=True)
    parser.add_argument("--spry-binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--transport", choices=["udp", "tcp", "tls", "all"], default="all")
    parser.add_argument("--seconds", type=int, default=30)
    parser.add_argument("--chrome")
    args = parser.parse_args()
    if not 15 <= args.seconds <= 300:
        parser.error("seconds must be between 15 and 300")
    binary = args.spry_binary.resolve()
    spec = importlib.util.spec_from_file_location("spry_interop", args.spry_repo.resolve() / "tests/interop.py")
    interop = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(interop)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    receipt = {
        "scope": "desktop Chrome HLS and actual RelaySwarm through Spry, loopback only; not physical-phone or NAT acceptance",
        "spry_binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "relayswarm_source": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_hashes": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in [
            "src/browser/hls-swarm.mjs", "src/browser/peer-link.mjs", "test/hls-swarm-browser.mjs", "test/browser/viewer.mjs"]},
        "generated_media": "FFmpeg testsrc2 and sine, H.264/AAC HLS",
        "results": [],
    }
    transports = ["udp", "tcp", "tls"] if args.transport == "all" else [args.transport]
    try:
        for transport in transports:
            fixture = interop.Fixture(binary, tls=transport == "tls", limits=("--relay-ports", "49160:49223"))
            try:
                username = f"{int(time.time()) + 900}:generated-hls"
                credential = base64.b64encode(hmac.digest(fixture.secret.encode(), username.encode(), "sha1")).decode()
                url = f"turns:127.0.0.1:{fixture.tls_port}?transport=tcp" if transport == "tls" else f"turn:127.0.0.1:{fixture.port}?transport={transport}"
                with tempfile.TemporaryDirectory(prefix="relayswarm-spry-") as scratch:
                    config = Path(scratch) / "ice.json"
                    config.write_text(json.dumps({"iceServers": [{"urls": url, "username": username, "credential": credential}],
                        "iceTransportPolicy": "relay", "expectedRelayProtocol": transport, "relayPortRange": [49160, 49223]}))
                    config.chmod(0o600)
                    results = output / transport
                    command = ["node", "test/hls-swarm-browser.mjs", "--mode", "shadow", "--viewers", "2", "--duration", str(args.seconds),
                        "--waves", "1", "--stagger", "3000", "--maxPeers", "3", "--corruptPeer", "1", "--iceConfig", str(config),
                        "--resultsDir", str(results), "--testTlsBypass", "1" if transport == "tls" else "0"]
                    if args.chrome:
                        command.extend(["--chrome", args.chrome])
                    with (output / f"{transport}.log").open("w") as log:
                        status = run_owned(command, log, args.seconds + 150)
                    files = sorted(results.glob("*.json")) if results.exists() else []
                    summary = json.loads(files[-1].read_text()) if files else None
                    receipt["results"].append({"transport": transport, "exit": status, "receipt": str(files[-1].relative_to(output)) if files else None,
                        "ok": status == 0 and bool(summary and summary.get("ok")), "aggregate": summary.get("aggregate") if summary else None,
                        "failures": summary.get("failures") if summary else ["harness did not produce a completed receipt"]})
                    print(json.dumps(receipt["results"][-1]), flush=True)
                    if not receipt["results"][-1]["ok"]:
                        raise RuntimeError(f"{transport} failed; private logs and scalar failure receipt retained")
            finally:
                fixture.close()
    finally:
        receipt["ok"] = len(receipt["results"]) == len(transports) and all(row["ok"] for row in receipt["results"])
        (output / "result.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
