"""Hardened stateful Python notebook kernel subprocess manager."""

from __future__ import annotations

import ast
import asyncio
import atexit
import collections
import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.config import Settings
from backend.services.package_guard import (
    PackageGuard,
    build_scrubbed_env,
    ensure_safe_dir,
    resolve_sandbox_user,
)

logger = logging.getLogger(__name__)

_SAFE_SESSION_RE = re.compile(r"[^A-Za-z0-9_-]")
_WORKER_SOURCE_PATH = Path(__file__).resolve().with_name("notebook_worker.py")
_KERNEL_STARTUP_TIMEOUT_SECONDS = 20


def _sanitize_session_id(session_id: str) -> str:
    """Convert an arbitrary session ID into a traversal-proof directory suffix."""
    raw = (session_id or "default").strip()
    cleaned = _SAFE_SESSION_RE.sub("_", raw).strip("._-")
    if not cleaned or cleaned != raw or len(cleaned) > 48:
        digest = hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:16]
        prefix = (cleaned[:24] or "session").strip("._-") or "session"
        return f"{prefix}_{digest}"
    return cleaned


def _sandbox_dir_for_session(session_id: str) -> Path:
    """Resolve ``<tempdir>/sandbox_<safe_id>`` and guarantee it is not a symlink and stays inside tempdir."""
    base_tmp = Path(tempfile.gettempdir()).resolve()
    safe_id = _sanitize_session_id(session_id)
    return ensure_safe_dir(
        base_tmp / f"sandbox_{safe_id}",
        expected_parent=base_tmp,
        label="sandbox directory",
    )


def _extract_pip_magics(code: str) -> tuple[list[tuple[str, str]], str]:
    """Extract ``%pip ...`` magic lines if the cell is not already valid Python syntax."""
    if not code or "%pip" not in code:
        return ([], code)

    try:
        ast.parse(code, filename="<cell>", mode="exec")
        return ([], code)
    except SyntaxError:
        pass

    pip_cmds: list[tuple[str, str]] = []
    remaining_lines: list[str] = []

    for line in code.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("%pip") and (
            len(stripped) == 4 or stripped[4].isspace()
        ):
            rest = stripped[4:].strip()
            if not rest:
                pip_cmds.append(("", ""))
            else:
                parts = rest.split(None, 1)
                subcmd = parts[0].lower()
                raw_args = parts[1].strip() if len(parts) > 1 else ""
                pip_cmds.append((subcmd, raw_args))
        else:
            remaining_lines.append(line)

    return (pip_cmds, "\n".join(remaining_lines))


@contextlib.asynccontextmanager
async def _acquire_lock_async(lock: threading.Lock):
    """Acquire a threading.Lock asynchronously without leaking the lock if cancelled."""
    state_lock = threading.Lock()
    cancelled = False
    acquired = False

    def _try_acquire() -> bool:
        nonlocal acquired
        if not lock.acquire(timeout=0.05):
            return False
        with state_lock:
            if cancelled:
                lock.release()
                return False
            acquired = True
            return True

    try:
        while True:
            if await asyncio.to_thread(_try_acquire):
                break
        yield
    except BaseException:
        with state_lock:
            cancelled = True
            should_release = acquired
            acquired = False
        if should_release:
            lock.release()
        raise
    else:
        with state_lock:
            should_release = acquired
            acquired = False
        if should_release:
            lock.release()


class _StderrCollector:
    """Continuously drains a subprocess stderr pipe into a bounded buffer on a daemon thread."""

    def __init__(self, stream: Any, max_chars: int = 32 * 1024) -> None:
        self._stream = stream
        self._max_chars = max_chars
        self._chunks: collections.deque[str] = collections.deque()
        self._total_chars = 0
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._drain, daemon=True)
        self._thread.start()

    def _drain(self) -> None:
        try:
            while True:
                chunk = self._stream.read(4096)
                if not chunk:
                    break
                with self._lock:
                    self._chunks.append(chunk)
                    self._total_chars += len(chunk)
                    while self._total_chars > self._max_chars and len(self._chunks) > 1:
                        dropped = self._chunks.popleft()
                        self._total_chars -= len(dropped)
        except (OSError, ValueError):
            pass

    def get_text(self) -> str:
        with self._lock:
            text = "".join(self._chunks)
            if len(text) > self._max_chars:
                return text[-self._max_chars:]
            return text


def _terminate_process(proc: subprocess.Popen[str] | None) -> None:
    """Terminate a kernel subprocess and its entire process group/tree, then close stdio handles."""
    if proc is None:
        return
    try:
        if os.name == "nt":
            if proc.poll() is None:
                try:
                    # Kill entire process tree (worker + any grandchildren) before parent exits.
                    subprocess.run(
                        ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                        capture_output=True,
                        timeout=5,
                        check=False,
                    )
                except (OSError, subprocess.SubprocessError):
                    pass
                if proc.poll() is None:
                    proc.kill()
                try:
                    proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    pass
        else:
            # Worker runs in its own session/process group (PGID == proc.pid).
            killpg = getattr(os, "killpg", None)
            if proc.poll() is None:
                if killpg is not None:
                    try:
                        killpg(proc.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    except PermissionError:
                        proc.terminate()
                else:
                    proc.terminate()
                try:
                    proc.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    pass

            # Always SIGKILL the full process group so orphaned grandchildren cannot survive.
            if killpg is not None:
                try:
                    killpg(proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass

            if proc.poll() is None:
                proc.kill()
            try:
                proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                pass
    except OSError:
        pass
    finally:
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass


def _remove_dir_with_retry(path: Path) -> None:
    """Delete a sandbox directory, retrying briefly on Windows handle release lag."""
    if not path.exists():
        return
    for attempt in range(4):
        try:
            shutil.rmtree(path)
            return
        except PermissionError:
            if attempt < 3:
                time.sleep(0.05)
        except OSError:
            break
    shutil.rmtree(path, ignore_errors=True)


@dataclass
class _KernelSession:
    session_id: str
    sandbox_dir: Path
    site_packages_dir: Path
    tmp_dir: Path
    process: subprocess.Popen[str] | None = None
    stderr_collector: _StderrCollector | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)
    execution_count: int = 0
    last_activity: float = field(default_factory=time.monotonic)


class NotebookKernelManager:
    """Manages isolated, stateful Python kernel subprocesses keyed by ``session_id``."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.package_guard = PackageGuard(settings)
        self._sessions: dict[str, _KernelSession] = {}
        self._manager_lock = threading.Lock()
        self._worker_runtime_dir: Path | None = None
        self._worker_script_path: Path | None = None
        atexit.register(self._cleanup_worker_runtime_dir)

    def _ensure_worker_script(self) -> Path:
        """Maintain an app-owned, read-only copy of notebook_worker.py outside sandbox dirs."""
        with self._manager_lock:
            if self._worker_script_path is not None and self._worker_script_path.is_file():
                return self._worker_script_path

            runtime_dir = Path(tempfile.mkdtemp(prefix="notebook_worker_")).resolve()
            worker_path = runtime_dir / "worker.py"
            shutil.copyfile(_WORKER_SOURCE_PATH, worker_path)
            if os.name != "nt":
                try:
                    os.chmod(runtime_dir, 0o755)
                    os.chmod(worker_path, 0o644)
                except OSError:
                    pass
            self._worker_runtime_dir = runtime_dir
            self._worker_script_path = worker_path
            return worker_path

    def _cleanup_worker_runtime_dir(self) -> None:
        runtime_dir = self._worker_runtime_dir
        self._worker_runtime_dir = None
        self._worker_script_path = None
        if runtime_dir is not None and runtime_dir.exists():
            shutil.rmtree(runtime_dir, ignore_errors=True)

    def _prepare_session_dirs(self, session_id: str) -> tuple[Path, Path, Path]:
        sandbox_dir = _sandbox_dir_for_session(session_id)
        site_packages_dir = ensure_safe_dir(
            sandbox_dir / "site-packages",
            expected_parent=sandbox_dir,
            label="site-packages directory",
        )
        tmp_dir = ensure_safe_dir(
            sandbox_dir / "tmp",
            expected_parent=sandbox_dir,
            label="sandbox temporary directory",
        )

        sandbox_dir.mkdir(parents=True, exist_ok=True)
        site_packages_dir.mkdir(parents=True, exist_ok=True)
        tmp_dir.mkdir(parents=True, exist_ok=True)

        if os.name != "nt":
            sandbox_user, uid, gid = resolve_sandbox_user(self.settings)
            geteuid = getattr(os, "geteuid", None)
            if sandbox_user is not None and uid is not None and gid is not None and geteuid and geteuid() == 0:
                chown_kwargs: dict[str, Any] = {}
                if os.chown in os.supports_follow_symlinks:
                    chown_kwargs["follow_symlinks"] = False
                for target_path in (sandbox_dir, site_packages_dir, tmp_dir):
                    if target_path.is_symlink():
                        raise ValueError(f"Refusing to chown symlinked path: {target_path}")
                    try:
                        os.chown(target_path, uid, gid, **chown_kwargs)
                    except OSError:
                        pass
                if not sandbox_dir.is_symlink():
                    try:
                        os.chmod(sandbox_dir, 0o700)
                    except OSError:
                        pass

        return (sandbox_dir, site_packages_dir, tmp_dir)

    def _get_or_create_session(self, session_id: str) -> _KernelSession:
        with self._manager_lock:
            session = self._sessions.get(session_id)
            if session is not None and session.sandbox_dir.exists() and not session.sandbox_dir.is_symlink():
                return session

            sandbox_dir, site_packages_dir, tmp_dir = self._prepare_session_dirs(session_id)
            session = _KernelSession(
                session_id=session_id,
                sandbox_dir=sandbox_dir,
                site_packages_dir=site_packages_dir,
                tmp_dir=tmp_dir,
            )
            self._sessions[session_id] = session
            return session

    async def _spawn_worker(self, session: _KernelSession) -> subprocess.Popen[str]:
        """Start a fresh worker subprocess with scrubbed env and wait until it answers ping."""
        worker_script = self._ensure_worker_script()
        # Always re-validate session directories so symlink replacement is rejected before spawn.
        self._prepare_session_dirs(session.session_id)

        env = build_scrubbed_env(
            sandbox_dir=session.sandbox_dir,
            site_packages_dir=session.site_packages_dir,
            tmp_dir=session.tmp_dir,
        )

        cmd = [
            sys.executable,
            "-u",
            str(worker_script),
            "--site-packages",
            str(session.site_packages_dir),
            "--max-memory-mb",
            str(self.settings.sandbox_max_memory_mb),
        ]

        popen_kwargs: dict[str, Any] = {
            "cwd": str(session.sandbox_dir),
            "env": env,
            "stdin": subprocess.PIPE,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "bufsize": 1,
        }

        if os.name == "nt":
            popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        else:
            popen_kwargs["start_new_session"] = True

        sandbox_user, _, _ = resolve_sandbox_user(self.settings)
        if sandbox_user is not None:
            popen_kwargs["user"] = sandbox_user

        proc = subprocess.Popen(cmd, **popen_kwargs)
        assert proc.stdin is not None and proc.stdout is not None
        stderr_collector = _StderrCollector(proc.stderr) if proc.stderr is not None else None

        # Complete ping/pong readiness handshake so interpreter startup latency
        # is never charged against the cell execution timeout.
        startup_timeout = max(
            _KERNEL_STARTUP_TIMEOUT_SECONDS,
            int(self.settings.sandbox_cell_timeout_seconds),
        )
        try:
            proc.stdin.write(json.dumps({"op": "ping"}) + "\n")
            proc.stdin.flush()
            ready_line = await asyncio.wait_for(
                asyncio.to_thread(proc.stdout.readline),
                timeout=startup_timeout,
            )
            ready_data = json.loads(ready_line) if ready_line else {}
            if not ready_data.get("pong"):
                raise RuntimeError("Kernel worker failed readiness handshake.")
        except Exception as exc:
            stderr_tail = stderr_collector.get_text() if stderr_collector is not None else ""
            _terminate_process(proc)
            detail = f" ({stderr_tail.strip()})" if stderr_tail.strip() else ""
            raise RuntimeError(f"Failed to start notebook kernel worker: {exc}{detail}") from exc

        session.process = proc
        session.stderr_collector = stderr_collector
        session.execution_count = 0
        session.last_activity = time.monotonic()
        return proc

    async def _ensure_live_worker(self, session: _KernelSession) -> subprocess.Popen[str]:
        proc = session.process
        if proc is None or proc.poll() is not None:
            _terminate_process(proc)
            session.process = None
            session.stderr_collector = None
            proc = await self._spawn_worker(session)
        return proc

    async def execute_cell(
        self,
        session_id: str,
        code: str,
        allow_package_install: bool = False,
    ) -> dict[str, Any]:
        """Execute a Python notebook cell in the session's persistent kernel subprocess."""
        started = time.perf_counter()
        session = self._get_or_create_session(session_id)

        async with _acquire_lock_async(session.lock):
            session.last_activity = time.monotonic()
            pip_cmds, remaining_code = _extract_pip_magics(code or "")
            pip_outputs: list[str] = []

            if pip_cmds:
                if not allow_package_install:
                    return {
                        "ok": False,
                        "execution_count": session.execution_count,
                        "stdout": "",
                        "stderr": "",
                        "html": None,
                        "image_png_base64": None,
                        "error": "Package installation (%pip) is disabled for this assessment.",
                        "duration_ms": int((time.perf_counter() - started) * 1000),
                    }

                for subcmd, raw_spec in pip_cmds:
                    if subcmd != "install" or not raw_spec:
                        return {
                            "ok": False,
                            "execution_count": session.execution_count,
                            "stdout": "\n".join(pip_outputs),
                            "stderr": "",
                            "html": None,
                            "image_png_base64": None,
                            "error": "Only '%pip install <package>' is supported in notebook cells.",
                            "duration_ms": int((time.perf_counter() - started) * 1000),
                        }

                    install_res = await self.package_guard.install_package(
                        raw_spec, session.site_packages_dir
                    )
                    if install_res.get("output"):
                        pip_outputs.append(str(install_res["output"]))
                    if not install_res.get("ok"):
                        return {
                            "ok": False,
                            "execution_count": session.execution_count,
                            "stdout": "\n".join(pip_outputs),
                            "stderr": "",
                            "html": None,
                            "image_png_base64": None,
                            "error": install_res.get("error") or "Package installation failed.",
                            "duration_ms": int((time.perf_counter() - started) * 1000),
                        }

                if not remaining_code.strip():
                    session.execution_count += 1
                    session.last_activity = time.monotonic()
                    return {
                        "ok": True,
                        "execution_count": session.execution_count,
                        "stdout": "\n".join(pip_outputs),
                        "stderr": "",
                        "html": None,
                        "image_png_base64": None,
                        "error": None,
                        "duration_ms": int((time.perf_counter() - started) * 1000),
                    }

            exec_code = remaining_code if pip_cmds else (code or "")
            result = await self._run_in_worker(session, exec_code)

            if pip_outputs:
                prefix = "\n".join(pip_outputs)
                existing_stdout = result.get("stdout") or ""
                result["stdout"] = f"{prefix}\n{existing_stdout}" if existing_stdout else prefix

            session.last_activity = time.monotonic()
            return result

    async def _run_in_worker(
        self,
        session: _KernelSession,
        code: str,
    ) -> dict[str, Any]:
        proc = await self._ensure_live_worker(session)
        assert proc.stdin is not None and proc.stdout is not None

        cell_started = time.perf_counter()
        payload = json.dumps({"code": code}) + "\n"
        try:
            proc.stdin.write(payload)
            proc.stdin.flush()
        except OSError:
            # Worker pipe broke before send; respawn once and retry.
            _terminate_process(proc)
            session.process = None
            session.stderr_collector = None
            proc = await self._spawn_worker(session)
            assert proc.stdin is not None and proc.stdout is not None
            cell_started = time.perf_counter()
            proc.stdin.write(payload)
            proc.stdin.flush()

        timeout_s = max(1, int(self.settings.sandbox_cell_timeout_seconds))

        try:
            raw_line = await asyncio.wait_for(
                asyncio.to_thread(proc.stdout.readline),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError:
            _terminate_process(proc)
            session.process = None
            session.stderr_collector = None
            session.execution_count = 0
            # Respawn lazily on next cell (or immediately via restart_kernel)
            return {
                "ok": False,
                "execution_count": 0,
                "stdout": "",
                "stderr": "",
                "html": None,
                "image_png_base64": None,
                "error": f"Cell execution timed out after {timeout_s}s. Kernel was restarted.",
                "duration_ms": int((time.perf_counter() - cell_started) * 1000),
            }

        if not raw_line:
            stderr_tail = (
                session.stderr_collector.get_text()
                if session.stderr_collector is not None
                else ""
            )
            _terminate_process(proc)
            session.process = None
            session.stderr_collector = None
            session.execution_count = 0
            err_msg = "Kernel process terminated unexpectedly and was restarted."
            if stderr_tail.strip():
                err_msg = f"{err_msg}\n{stderr_tail.strip()}"
            return {
                "ok": False,
                "execution_count": 0,
                "stdout": "",
                "stderr": stderr_tail,
                "html": None,
                "image_png_base64": None,
                "error": err_msg,
                "duration_ms": int((time.perf_counter() - cell_started) * 1000),
            }

        try:
            data = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            _terminate_process(proc)
            session.process = None
            session.stderr_collector = None
            session.execution_count = 0
            return {
                "ok": False,
                "execution_count": 0,
                "stdout": "",
                "stderr": "",
                "html": None,
                "image_png_base64": None,
                "error": f"Malformed kernel response ({exc}). Kernel was restarted.",
                "duration_ms": int((time.perf_counter() - cell_started) * 1000),
            }

        exec_count = int(data.get("execution_count", session.execution_count + 1))
        session.execution_count = exec_count

        return {
            "ok": bool(data.get("ok", False)),
            "execution_count": exec_count,
            "stdout": str(data.get("stdout", "") or ""),
            "stderr": str(data.get("stderr", "") or ""),
            "html": data.get("html"),
            "image_png_base64": data.get("image_png_base64"),
            "error": data.get("error"),
            "duration_ms": int((time.perf_counter() - cell_started) * 1000),
        }

    async def install_package(self, session_id: str, spec: str) -> dict[str, Any]:
        """Validate and install a PyPI package into the session's isolated site-packages."""
        session = self._get_or_create_session(session_id)
        async with _acquire_lock_async(session.lock):
            session.last_activity = time.monotonic()
            result = await self.package_guard.install_package(spec, session.site_packages_dir)
            session.last_activity = time.monotonic()
            return result

    async def restart_kernel(self, session_id: str) -> dict[str, Any]:
        """Terminate and cleanly respawn the session kernel while retaining site-packages."""
        session = self._get_or_create_session(session_id)
        async with _acquire_lock_async(session.lock):
            _terminate_process(session.process)
            session.process = None
            session.stderr_collector = None
            await self._spawn_worker(session)
            return {
                "ok": True,
                "session_id": session_id,
                "restarted": True,
            }

    def cleanup_session(self, session_id: str) -> None:
        """Terminate the session kernel and delete its isolated sandbox directory."""
        with self._manager_lock:
            session = self._sessions.pop(session_id, None)

        if session is not None:
            with session.lock:
                _terminate_process(session.process)
                session.process = None
                session.stderr_collector = None
                _remove_dir_with_retry(session.sandbox_dir)
        else:
            try:
                sandbox_dir = _sandbox_dir_for_session(session_id)
                _remove_dir_with_retry(sandbox_dir)
            except ValueError:
                pass

    def reap_idle_kernels(self) -> int:
        """Terminate and delete all kernels idle past ``sandbox_idle_timeout_minutes``."""
        cutoff_seconds = max(0, int(self.settings.sandbox_idle_timeout_minutes)) * 60
        now = time.monotonic()

        with self._manager_lock:
            expired_ids = [
                sid
                for sid, sess in self._sessions.items()
                if (now - sess.last_activity) >= cutoff_seconds
            ]

        for sid in expired_ids:
            self.cleanup_session(sid)

        return len(expired_ids)

    def shutdown_all(self) -> None:
        """Terminate and clean up all active kernel sessions and runtime worker files."""
        with self._manager_lock:
            all_ids = list(self._sessions.keys())
        for sid in all_ids:
            self.cleanup_session(sid)
        self._cleanup_worker_runtime_dir()
