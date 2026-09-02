#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import socketserver
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

REPO = Path(os.environ.get("QUANTUM_REPO_ROOT", "/opt/quantum-trading")).resolve()
BRANCH = os.environ.get("QUANTUM_UPDATE_BRANCH", "feature/v34-dual-market-engine")
SOCKET_PATH = os.environ.get("QUANTUM_UPDATE_SOCKET", "/run/quantum-updater.sock")
LOG_PATH = Path(os.environ.get("QUANTUM_UPDATE_LOG", "/var/log/quantum-updater.log"))

_lock = threading.Lock()
_state = {
    "busy": False,
    "phase": "IDLE",
    "startedAt": None,
    "completedAt": None,
    "lastOk": None,
    "lastError": None,
    "lastOutput": "",
}


def run(args: list[str], timeout: int = 60) -> str:
    return subprocess.check_output(args, cwd=REPO, stderr=subprocess.STDOUT, text=True, timeout=timeout).strip()


def current_sha() -> str:
    try:
        return run(["git", "rev-parse", "HEAD"], 15)
    except Exception:
        return ""


def remote_sha() -> str:
    try:
        output = run(["git", "ls-remote", "origin", f"refs/heads/{BRANCH}"], 30)
        return output.split()[0] if output else ""
    except Exception:
        return ""


def release_text() -> str:
    path = REPO / "public" / "release.txt"
    try:
        return path.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def dirty() -> list[str]:
    try:
        text = run(["git", "status", "--porcelain"], 15)
        return [line for line in text.splitlines() if line.strip()]
    except Exception as exc:
        return [f"STATUS_ERROR:{exc}"]


def status_payload(check_remote: bool = True) -> dict:
    current = current_sha()
    remote = remote_sha() if check_remote else ""
    with _lock:
        runtime = dict(_state)
    return {
        "ok": True,
        "repo": str(REPO),
        "branch": BRANCH,
        "currentSha": current,
        "remoteSha": remote,
        "updateAvailable": bool(current and remote and current != remote),
        "dirty": dirty(),
        "release": release_text(),
        "agent": runtime,
        "checkedAt": int(time.time() * 1000),
    }


def append_log(text: str) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(text + "\n")
    except Exception:
        pass


def apply_update() -> None:
    with _lock:
        if _state["busy"]:
            return
        _state.update({
            "busy": True,
            "phase": "STARTING",
            "startedAt": int(time.time() * 1000),
            "completedAt": None,
            "lastOk": None,
            "lastError": None,
            "lastOutput": "",
        })

    output: list[str] = []
    try:
        local_dirty = dirty()
        if local_dirty:
            raise RuntimeError("REPOSITORY_DIRTY:" + " | ".join(local_dirty[:20]))

        steps = [
            ("FETCH", ["git", "fetch", "origin", BRANCH]),
            ("CHECKOUT", ["git", "checkout", BRANCH]),
            ("RESET", ["git", "reset", "--hard", f"origin/{BRANCH}"]),
            ("DEPLOY", ["bash", "update-v34-linux.sh", "--from-agent"]),
        ]
        for phase, args in steps:
            with _lock:
                _state["phase"] = phase
            append_log(f"[{time.strftime('%F %T')}] {phase}: {' '.join(args)}")
            proc = subprocess.run(
                args,
                cwd=REPO,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=1800,
                check=False,
            )
            output.append(f"## {phase}\n{proc.stdout[-12000:]}")
            if proc.returncode != 0:
                raise RuntimeError(f"{phase}_FAILED_EXIT_{proc.returncode}")

        with _lock:
            _state.update({
                "busy": False,
                "phase": "COMPLETED",
                "completedAt": int(time.time() * 1000),
                "lastOk": True,
                "lastError": None,
                "lastOutput": "\n".join(output)[-20000:],
            })
        append_log(f"[{time.strftime('%F %T')}] UPDATE COMPLETED")
    except Exception as exc:
        with _lock:
            _state.update({
                "busy": False,
                "phase": "ERROR",
                "completedAt": int(time.time() * 1000),
                "lastOk": False,
                "lastError": str(exc),
                "lastOutput": "\n".join(output)[-20000:],
            })
        append_log(f"[{time.strftime('%F %T')}] UPDATE ERROR: {exc}")


class UnixHTTPServer(socketserver.UnixStreamServer):
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = "QuantumUpdater/1.0"

    def log_message(self, fmt: str, *args) -> None:
        return

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.startswith("/status"):
            self.send_json(status_payload(check_remote=False))
            return
        if self.path.startswith("/check"):
            self.send_json(status_payload(check_remote=True))
            return
        self.send_json({"ok": False, "error": "NOT_FOUND"}, 404)

    def do_POST(self) -> None:
        if not self.path.startswith("/apply"):
            self.send_json({"ok": False, "error": "NOT_FOUND"}, 404)
            return
        with _lock:
            if _state["busy"]:
                self.send_json({"ok": False, "error": "UPDATE_ALREADY_RUNNING", "agent": dict(_state)}, 409)
                return
        if dirty():
            self.send_json({"ok": False, "error": "REPOSITORY_DIRTY", "dirty": dirty()}, 409)
            return
        thread = threading.Thread(target=apply_update, daemon=True)
        thread.start()
        self.send_json({"ok": True, "started": True, "agent": dict(_state)}, 202)


def main() -> None:
    if not REPO.exists():
        raise SystemExit(f"Repository does not exist: {REPO}")
    try:
        os.unlink(SOCKET_PATH)
    except FileNotFoundError:
        pass
    Path(SOCKET_PATH).parent.mkdir(parents=True, exist_ok=True)
    server = UnixHTTPServer(SOCKET_PATH, Handler)
    os.chmod(SOCKET_PATH, 0o666)
    append_log(f"[{time.strftime('%F %T')}] agent started repo={REPO} branch={BRANCH}")
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        try:
            os.unlink(SOCKET_PATH)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
