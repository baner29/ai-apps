"""Tests for PackageGuard, notebook_worker, and NotebookKernelManager."""

from __future__ import annotations

import asyncio
import base64
import os
import subprocess
import tempfile
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.config import Settings
from backend.services.notebook_kernel import NotebookKernelManager
from backend.services.package_guard import PackageGuard


def test_package_guard_blocks_banned_urls_flags_and_oversized():
    guard = PackageGuard(Settings(sandbox_max_package_mb=25))
    bad_specs = [
        "torch",
        "TensorFlow==2.15",
        "llama_cpp_python",
        "OpenCV_Python>=4.0",
        "git+https://github.com/a/b.git",
        "https://evil.com/x.whl",
        "http://evil.com/pkg.tar.gz",
        "file:///tmp/evil.whl",
        "foo @ https://evil.com/foo.whl",
        "evil.whl",
        "../local_pkg",
        "--index-url http://x foo",
        "-r req.txt",
        "-e .",
        "   ",
    ]
    for bad in bad_specs:
        with pytest.raises(ValueError, match="."):
            guard.validate_package_spec(bad)

    name, spec = guard.validate_package_spec("tabulate>=0.9")
    assert name == "tabulate" and spec == "tabulate>=0.9"

    name2, spec2 = guard.validate_package_spec("python_dateutil>=2.8,<3.0")
    assert name2 == "python-dateutil" and spec2 == "python_dateutil>=2.8,<3.0"

    # Oversized PyPI metadata check
    big_resp = MagicMock(status_code=200)
    big_resp.json.return_value = {
        "urls": [{"size": 80 * 1024 * 1024, "packagetype": "bdist_wheel"}]
    }
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=big_resp)):
        with pytest.raises(ValueError, match="limit|size|MB"):
            asyncio.run(guard.check_pypi_size("hugepkg"))


def test_package_guard_pypi_404_and_valid_size():
    guard = PackageGuard(Settings(sandbox_max_package_mb=25))

    not_found = MagicMock(status_code=404)
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=not_found)):
        with pytest.raises(ValueError, match="not found|404"):
            asyncio.run(guard.check_pypi_size("definitely-not-on-pypi-xyz"))

    ok_resp = MagicMock(status_code=200)
    ok_resp.json.return_value = {
        "urls": [
            {"size": 2 * 1024 * 1024, "packagetype": "bdist_wheel"},
            {"size": 3 * 1024 * 1024, "packagetype": "sdist"},
        ]
    }
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=ok_resp)):
        size_mb = asyncio.run(guard.check_pypi_size("tabulate"))
        assert size_mb == pytest.approx(3.0, rel=1e-2)


def test_package_guard_install_scrubs_env_and_rolls_back_disk_cap(tmp_path, monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", "sk-secret-for-pip-test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "aws-secret-for-pip-test")
    monkeypatch.setenv("ADMIN_PASSWORD", "admin-secret-for-pip-test")
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret-for-pip-test")

    target_dir = tmp_path / "site-packages"
    target_dir.mkdir(parents=True)
    # Pre-existing package file that must survive rollback
    existing_file = target_dir / "existing_mod.py"
    existing_file.write_text("X = 1\n", encoding="utf-8")

    guard = PackageGuard(Settings(sandbox_max_package_mb=25, sandbox_max_disk_mb=1))
    captured_call: dict = {}

    small_resp = MagicMock(status_code=200)
    small_resp.json.return_value = {
        "urls": [{"size": 512 * 1024, "packagetype": "bdist_wheel"}]
    }

    def fake_run(cmd, **kwargs):
        captured_call["cmd"] = cmd
        captured_call["env"] = kwargs.get("env", {})
        # Simulate pip writing > 1 MB into target_dir
        new_pkg_dir = target_dir / "bloated_dep"
        new_pkg_dir.mkdir(exist_ok=True)
        (new_pkg_dir / "weights.bin").write_bytes(b"\x00" * (2 * 1024 * 1024))
        return subprocess.CompletedProcess(cmd, 0, stdout="Successfully installed tinywrapper", stderr="")

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=small_resp)), patch(
        "backend.services.package_guard.subprocess.run", side_effect=fake_run
    ):
        res = asyncio.run(guard.install_package("tinywrapper==1.0", target_dir))

    assert res["ok"] is False
    assert "disk" in (res["error"] or "").lower() or "limit" in (res["error"] or "").lower()
    # Rollback must remove newly added bloated files while preserving pre-existing ones
    assert not (target_dir / "bloated_dep").exists()
    assert existing_file.exists()

    # Verify scrubbed env passed to pip
    pip_env = captured_call["env"]
    for secret_key in ("LLM_API_KEY", "AWS_SECRET_ACCESS_KEY", "ADMIN_PASSWORD", "SMTP_PASSWORD"):
        assert secret_key not in pip_env
    assert "--no-cache-dir" in captured_call["cmd"]
    assert "--target" in captured_call["cmd"]
    assert "--" in captured_call["cmd"]


def test_package_guard_rolls_back_banned_transitive_dependency(tmp_path):
    target_dir = tmp_path / "site-packages"
    target_dir.mkdir(parents=True)
    keep_file = target_dir / "safe_existing.py"
    keep_file.write_text("OK = True\n", encoding="utf-8")

    guard = PackageGuard(Settings(sandbox_max_package_mb=25, sandbox_max_disk_mb=150))

    small_resp = MagicMock(status_code=200)
    small_resp.json.return_value = {
        "urls": [{"size": 100 * 1024, "packagetype": "bdist_wheel"}]
    }

    def fake_run(cmd, **kwargs):
        # Simulate a benign-named wrapper pulling in banned transitive `torch`
        dist_info = target_dir / "torch-2.3.0.dist-info"
        dist_info.mkdir(exist_ok=True)
        (dist_info / "METADATA").write_text("Metadata-Version: 2.1\nName: torch\nVersion: 2.3.0\n", encoding="utf-8")
        wrapper_dir = target_dir / "sneaky_wrapper"
        wrapper_dir.mkdir(exist_ok=True)
        (wrapper_dir / "__init__.py").write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout="Successfully installed sneaky-wrapper torch", stderr="")

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=small_resp)), patch(
        "backend.services.package_guard.subprocess.run", side_effect=fake_run
    ):
        res = asyncio.run(guard.install_package("sneaky-wrapper", target_dir))

    assert res["ok"] is False
    assert "torch" in (res["error"] or "").lower()
    assert not (target_dir / "torch-2.3.0.dist-info").exists()
    assert not (target_dir / "sneaky_wrapper").exists()
    assert keep_file.exists()


def test_package_guard_install_success(tmp_path):
    target_dir = tmp_path / "site-packages"
    target_dir.mkdir(parents=True)
    guard = PackageGuard(Settings(sandbox_max_package_mb=25, sandbox_max_disk_mb=150))

    ok_resp = MagicMock(status_code=200)
    ok_resp.json.return_value = {
        "urls": [{"size": 50 * 1024, "packagetype": "bdist_wheel"}]
    }

    def fake_run(cmd, **kwargs):
        mod_dir = target_dir / "tabulate"
        mod_dir.mkdir(exist_ok=True)
        (mod_dir / "__init__.py").write_text("def tabulate(rows): return str(rows)\n", encoding="utf-8")
        dist = target_dir / "tabulate-0.9.0.dist-info"
        dist.mkdir(exist_ok=True)
        (dist / "METADATA").write_text("Name: tabulate\nVersion: 0.9.0\n", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout="Successfully installed tabulate-0.9.0", stderr="")

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=ok_resp)), patch(
        "backend.services.package_guard.subprocess.run", side_effect=fake_run
    ):
        res = asyncio.run(guard.install_package("tabulate>=0.9", target_dir))

    assert res["ok"] is True
    assert res["package"] == "tabulate"
    assert res["error"] is None
    assert "tabulate" in res["output"]
    assert (target_dir / "tabulate" / "__init__.py").exists()


def test_notebook_kernel_persists_state_scrubs_env_and_enforces_timeout(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", "sk-super-secret-value")
    monkeypatch.setenv("ADMIN_PASSWORD", "admin-secret-value")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "aws-secret-value")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-secret-value")
    mgr = NotebookKernelManager(Settings(sandbox_cell_timeout_seconds=2))
    try:
        r1 = asyncio.run(mgr.execute_cell("sess-1", "a = 41\nprint('ready')"))
        assert r1["ok"] is True and "ready" in r1["stdout"] and r1["execution_count"] == 1
        assert isinstance(r1["duration_ms"], int) and r1["duration_ms"] >= 0

        r2 = asyncio.run(mgr.execute_cell("sess-1", "print(a + 1)"))
        assert r2["ok"] is True and "42" in r2["stdout"] and r2["execution_count"] == 2

        # Env scrubbing check (exact keys + full os.environ dump)
        r3 = asyncio.run(
            mgr.execute_cell(
                "sess-1",
                "import os; print(os.environ.get('LLM_API_KEY'), os.environ.get('ADMIN_PASSWORD')); print(dict(os.environ))",
            )
        )
        assert r3["ok"] is True
        for secret in ("sk-super-secret-value", "admin-secret-value", "aws-secret-value", "xoxb-secret-value"):
            assert secret not in r3["stdout"]

        # Timeout check
        r4 = asyncio.run(mgr.execute_cell("sess-1", "import time; time.sleep(5)"))
        assert r4["ok"] is False and "timed out" in (r4["error"] or "").lower()

        # After timeout, kernel must respawn cleanly and execute subsequent cells
        r5 = asyncio.run(mgr.execute_cell("sess-1", "b = 100\nprint(b)"))
        assert r5["ok"] is True and "100" in r5["stdout"]
    finally:
        mgr.cleanup_session("sess-1")


def test_notebook_kernel_renders_dataframe_html_and_matplotlib_png():
    mgr = NotebookKernelManager(Settings(sandbox_cell_timeout_seconds=15))
    try:
        r_df = asyncio.run(
            mgr.execute_cell(
                "sess-rich",
                "import pandas as pd\ndf = pd.DataFrame({'col_a': [1, 2], 'col_b': ['alpha', 'beta']})\ndf",
            )
        )
        assert r_df["ok"] is True
        assert r_df["html"] is not None
        assert "<table" in r_df["html"].lower()
        assert "alpha" in r_df["html"] and "beta" in r_df["html"]

        r_plot = asyncio.run(
            mgr.execute_cell(
                "sess-rich",
                "import matplotlib.pyplot as plt\nplt.figure()\nplt.plot([1, 2, 3], [4, 5, 6])\nplt.title('Test Plot')\nplt.show()",
            )
        )
        assert r_plot["ok"] is True
        assert r_plot["image_png_base64"] is not None
        png_bytes = base64.b64decode(r_plot["image_png_base64"])
        assert png_bytes.startswith(b"\x89PNG\r\n\x1a\n")

        # Next cell without a plot should not re-emit the previous plot
        r_plain = asyncio.run(mgr.execute_cell("sess-rich", "2 + 2"))
        assert r_plain["ok"] is True
        assert "4" in r_plain["stdout"]
        assert r_plain["image_png_base64"] is None
    finally:
        mgr.cleanup_session("sess-rich")


def test_notebook_kernel_magic_pip_install_and_security():
    mgr = NotebookKernelManager(Settings(sandbox_cell_timeout_seconds=10))
    try:
        # Disabled by default
        r_disabled = asyncio.run(
            mgr.execute_cell("sess-pip", "%pip install tabulate", allow_package_install=False)
        )
        assert r_disabled["ok"] is False
        assert "disabled" in (r_disabled["error"] or "").lower()

        # Enabled, but banned package or flag injection rejected by PackageGuard
        r_banned = asyncio.run(
            mgr.execute_cell("sess-pip", "%pip install torch", allow_package_install=True)
        )
        assert r_banned["ok"] is False
        assert "torch" in (r_banned["error"] or "").lower() or "blocked" in (r_banned["error"] or "").lower()

        r_flag = asyncio.run(
            mgr.execute_cell("sess-pip", "%pip install --index-url http://evil.com foo", allow_package_install=True)
        )
        assert r_flag["ok"] is False

        # Enabled, valid package install mocked into session site-packages + immediately importable in same cell
        async def fake_install(spec: str, target_dir: Path) -> dict:
            pkg_dir = target_dir / "demo_custom_pkg"
            pkg_dir.mkdir(parents=True, exist_ok=True)
            (pkg_dir / "__init__.py").write_text("VALUE = 999\n", encoding="utf-8")
            return {
                "ok": True,
                "package": "demo-custom-pkg",
                "size_mb": 0.01,
                "output": "Installed demo-custom-pkg",
                "error": None,
            }

        with patch.object(mgr.package_guard, "install_package", side_effect=fake_install):
            r_ok = asyncio.run(
                mgr.execute_cell(
                    "sess-pip",
                    "%pip install demo-custom-pkg\nimport demo_custom_pkg\nprint('val=', demo_custom_pkg.VALUE)",
                    allow_package_install=True,
                )
            )
        assert r_ok["ok"] is True
        assert "Installed demo-custom-pkg" in r_ok["stdout"]
        assert "val= 999" in r_ok["stdout"]
    finally:
        mgr.cleanup_session("sess-pip")


def test_notebook_kernel_restart_errors_isolation_and_idle_reaper():
    mgr = NotebookKernelManager(Settings(sandbox_cell_timeout_seconds=10, sandbox_idle_timeout_minutes=5))
    traversal_sid = "../../escape_attempt"
    try:
        # Path traversal session ID must stay strictly inside tempdir
        r_iso = asyncio.run(
            mgr.execute_cell(
                traversal_sid,
                "import os\nprint('CWD=' + os.getcwd())",
            )
        )
        assert r_iso["ok"] is True
        cwd_line = [ln for ln in r_iso["stdout"].splitlines() if ln.startswith("CWD=")][0]
        cwd_path = Path(cwd_line.split("=", 1)[1]).resolve()
        assert cwd_path.parent == Path(tempfile.gettempdir()).resolve()

        # Backend module must not be importable from candidate cell
        r_imp = asyncio.run(mgr.execute_cell(traversal_sid, "import backend"))
        assert r_imp["ok"] is False
        assert "ModuleNotFoundError" in (r_imp["error"] or "")

        # Syntax error & runtime error do not kill persistent state
        asyncio.run(mgr.execute_cell(traversal_sid, "keep_me = 'alive'"))
        r_syn = asyncio.run(mgr.execute_cell(traversal_sid, "def broken(:"))
        assert r_syn["ok"] is False and "SyntaxError" in (r_syn["error"] or "")
        r_rt = asyncio.run(mgr.execute_cell(traversal_sid, "1 / 0"))
        assert r_rt["ok"] is False and "ZeroDivisionError" in (r_rt["error"] or "")
        r_still = asyncio.run(mgr.execute_cell(traversal_sid, "print(keep_me)"))
        assert r_still["ok"] is True and "alive" in r_still["stdout"]

        # Restart resets in-memory variables while preserving site-packages
        sp_marker = cwd_path / "site-packages" / "marker_mod.py"
        sp_marker.write_text("FLAG = 'persisted'\n", encoding="utf-8")
        restart_res = asyncio.run(mgr.restart_kernel(traversal_sid))
        assert restart_res["ok"] is True
        r_gone = asyncio.run(mgr.execute_cell(traversal_sid, "print(keep_me)"))
        assert r_gone["ok"] is False and "NameError" in (r_gone["error"] or "")
        r_kept = asyncio.run(mgr.execute_cell(traversal_sid, "import marker_mod; print(marker_mod.FLAG)"))
        assert r_kept["ok"] is True and "persisted" in r_kept["stdout"]

        # Idle reaper reaps expired kernels and deletes sandbox directory
        assert mgr.reap_idle_kernels() == 0
        # Backdate session last_activity beyond idle timeout
        mgr._sessions[traversal_sid].last_activity = time.monotonic() - (6 * 60)
        reaped = mgr.reap_idle_kernels()
        assert reaped == 1
        assert not cwd_path.exists()
    finally:
        mgr.cleanup_session(traversal_sid)
        mgr.shutdown_all()


def test_notebook_kernel_install_package_immediately_importable():
    mgr = NotebookKernelManager(Settings(sandbox_cell_timeout_seconds=10))
    try:
        # Boot kernel first
        r0 = asyncio.run(mgr.execute_cell("sess-inst", "x = 7"))
        assert r0["ok"] is True

        async def fake_install(spec: str, target_dir: Path) -> dict:
            (target_dir / "hot_pkg.py").write_text("MULTIPLIER = 6\n", encoding="utf-8")
            return {
                "ok": True,
                "package": "hot-pkg",
                "size_mb": 0.01,
                "output": "Installed hot-pkg",
                "error": None,
            }

        with patch.object(mgr.package_guard, "install_package", side_effect=fake_install):
            res = asyncio.run(mgr.install_package("sess-inst", "hot-pkg==1.0"))
        assert res["ok"] is True

        # Must be importable in the EXISTING kernel without restart, preserving x = 7
        r1 = asyncio.run(mgr.execute_cell("sess-inst", "import hot_pkg\nprint(x * hot_pkg.MULTIPLIER)"))
        assert r1["ok"] is True
        assert "42" in r1["stdout"]
    finally:
        mgr.cleanup_session("sess-inst")
        mgr.shutdown_all()


def test_notebook_worker_module_cli_json_lines():
    import json
    import sys

    proc = subprocess.run(
        [sys.executable, "-m", "backend.services.notebook_worker"],
        input=json.dumps({"code": "val = 3 * 14\nval"}) + "\n",
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=20,
    )
    assert proc.returncode == 0
    resp = json.loads(proc.stdout.strip().splitlines()[0])
    assert resp["ok"] is True
    assert "42" in resp["stdout"]
    assert resp["execution_count"] == 1


def test_async_lock_cancellation_does_not_deadlock_session():
    mgr = NotebookKernelManager(Settings(sandbox_cell_timeout_seconds=10))
    session_id = "sess-cancel-lock"

    async def scenario():
        session = mgr._get_or_create_session(session_id)
        # Hold the session lock so a concurrent execute_cell blocks waiting to acquire it
        session.lock.acquire()
        waiter = asyncio.create_task(mgr.execute_cell(session_id, "print('cancelled')"))
        await asyncio.sleep(0.1)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        # Release the lock; any orphaned acquire thread must immediately release it too
        session.lock.release()
        await asyncio.sleep(0.15)
        assert not session.lock.locked()
        # A subsequent cell on the same session must acquire the lock and succeed
        res = await asyncio.wait_for(mgr.execute_cell(session_id, "print('recovered')"), timeout=20)
        assert res["ok"] is True
        assert "recovered" in res["stdout"]

    try:
        asyncio.run(scenario())
    finally:
        mgr.cleanup_session(session_id)
        mgr.shutdown_all()


def test_package_guard_rejects_symlinked_target_dir(tmp_path, monkeypatch):
    sandbox_dir = tmp_path / "sandbox_test"
    sandbox_dir.mkdir(parents=True)
    outside_dir = tmp_path / "outside_target"
    outside_dir.mkdir(parents=True)
    symlink_target = sandbox_dir / "site-packages"

    created_real_symlink = False
    try:
        os.symlink(outside_dir, symlink_target, target_is_directory=True)
        created_real_symlink = True
    except OSError:
        # Windows without Developer Mode / SeCreateSymbolicLinkPrivilege: simulate symlink
        symlink_target.mkdir()
        orig_is_symlink = Path.is_symlink

        def fake_is_symlink(self: Path) -> bool:
            if self == symlink_target:
                return True
            return orig_is_symlink(self)

        monkeypatch.setattr(Path, "is_symlink", fake_is_symlink)

    guard = PackageGuard(Settings(sandbox_max_package_mb=25, sandbox_max_disk_mb=150))
    ok_resp = MagicMock(status_code=200)
    ok_resp.json.return_value = {"urls": [{"size": 10 * 1024, "packagetype": "bdist_wheel"}]}

    pip_mock = MagicMock()
    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=ok_resp)), patch(
        "backend.services.package_guard.subprocess.run", pip_mock
    ):
        res = asyncio.run(guard.install_package("tabulate>=0.9", symlink_target))

    assert res["ok"] is False
    assert "symlink" in (res["error"] or "").lower()
    # pip must never have been invoked
    assert pip_mock.call_count == 0
    if created_real_symlink:
        assert not list(outside_dir.iterdir())


def test_package_guard_blocks_preexisting_banned_dir_bypass(tmp_path):
    target_dir = tmp_path / "site-packages"
    target_dir.mkdir(parents=True)
    # Candidate pre-creates matching top-level dirs before running %pip install
    pre_dist = target_dir / "torch-2.3.0.dist-info"
    pre_dist.mkdir()
    pre_pkg = target_dir / "torch"
    pre_pkg.mkdir()

    guard = PackageGuard(Settings(sandbox_max_package_mb=25, sandbox_max_disk_mb=150))
    ok_resp = MagicMock(status_code=200)
    ok_resp.json.return_value = {"urls": [{"size": 50 * 1024, "packagetype": "bdist_wheel"}]}

    def fake_run(cmd, **kwargs):
        (pre_dist / "METADATA").write_text("Name: torch\nVersion: 2.3.0\n", encoding="utf-8")
        (pre_pkg / "__init__.py").write_text("INSTALLED = True\n", encoding="utf-8")
        wrapper = target_dir / "sneaky_wrapper"
        wrapper.mkdir(exist_ok=True)
        (wrapper / "__init__.py").write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout="Successfully installed sneaky-wrapper torch", stderr="")

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=ok_resp)), patch(
        "backend.services.package_guard.subprocess.run", side_effect=fake_run
    ):
        res = asyncio.run(guard.install_package("sneaky-wrapper", target_dir))

    assert res["ok"] is False
    assert "torch" in (res["error"] or "").lower()
    # Newly written files must be rolled back
    assert not (pre_dist / "METADATA").exists()
    assert not (pre_pkg / "__init__.py").exists()
    assert not (target_dir / "sneaky_wrapper").exists()


def test_notebook_worker_isolates_fd1_and_drains_large_stderr():
    mgr = NotebookKernelManager(Settings(sandbox_cell_timeout_seconds=10))
    session_id = "sess-fd1-stderr"
    try:
        r1 = asyncio.run(
            mgr.execute_cell(
                session_id,
                (
                    "import os, sys\n"
                    "sys.__stdout__.write('CORRUPT_SYS_STDOUT\\n')\n"
                    "sys.__stdout__.flush()\n"
                    "os.write(1, b'CORRUPT_RAW_FD1\\n')\n"
                    "os.write(2, b'E' * (128 * 1024))\n"
                    "x = 123\n"
                    "print('clean-cell-1')\n"
                ),
            )
        )
        assert r1["ok"] is True
        assert "clean-cell-1" in r1["stdout"]

        # Kernel must stay alive and keep state (not restarted due to JSON corruption or stderr deadlock)
        r2 = asyncio.run(mgr.execute_cell(session_id, "print('clean-cell-2', x)"))
        assert r2["ok"] is True
        assert "clean-cell-2 123" in r2["stdout"]
        assert r2["execution_count"] == 2
    finally:
        mgr.cleanup_session(session_id)
        mgr.shutdown_all()


def _is_pid_alive(pid: int) -> bool:
    if os.name == "nt":
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True,
            text=True,
            check=False,
        )
        return str(pid) in (out.stdout or "")
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def test_notebook_kernel_timeout_kills_grandchild_processes():
    mgr = NotebookKernelManager(Settings(sandbox_cell_timeout_seconds=2))
    session_id = "sess-grandchild-timeout"
    try:
        # Warm up kernel and locate sandbox dir
        r0 = asyncio.run(mgr.execute_cell(session_id, "import os; print('DIR=' + os.getcwd())"))
        assert r0["ok"] is True
        sandbox_dir = Path(
            [ln for ln in r0["stdout"].splitlines() if ln.startswith("DIR=")][0].split("=", 1)[1]
        )

        # Spawn a long-sleeping grandchild process, write its PID, then block until cell timeout
        r_timeout = asyncio.run(
            mgr.execute_cell(
                session_id,
                (
                    "import subprocess, sys, time\n"
                    "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
                    "with open('child.pid', 'w', encoding='utf-8') as fh:\n"
                    "    fh.write(str(child.pid))\n"
                    "time.sleep(10)\n"
                ),
            )
        )
        assert r_timeout["ok"] is False
        assert "timed out" in (r_timeout["error"] or "").lower()

        pid_file = sandbox_dir / "child.pid"
        assert pid_file.exists()
        child_pid = int(pid_file.read_text(encoding="utf-8").strip())

        # Give OS a brief moment to finalize process table reaping
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and _is_pid_alive(child_pid):
            time.sleep(0.1)
        assert not _is_pid_alive(child_pid), f"Grandchild PID {child_pid} survived kernel timeout!"
    finally:
        mgr.cleanup_session(session_id)
        mgr.shutdown_all()


def test_package_guard_aborts_on_post_pip_symlink_swap_without_deleting_outside_files(
    tmp_path, monkeypatch
):
    from backend.services.package_guard import _dir_size_bytes, _rollback_new_entries

    sandbox_dir = tmp_path / "sandbox_toctou"
    target_dir = sandbox_dir / "site-packages"
    target_dir.mkdir(parents=True)

    outside_dir = tmp_path / "outside_victim"
    outside_dir.mkdir(parents=True)
    precious_file = outside_dir / "do_not_delete.txt"
    precious_file.write_text("keep-me", encoding="utf-8")

    guard = PackageGuard(Settings(sandbox_max_package_mb=25, sandbox_max_disk_mb=150))
    ok_resp = MagicMock(status_code=200)
    ok_resp.json.return_value = {"urls": [{"size": 10 * 1024, "packagetype": "bdist_wheel"}]}

    swapped = False
    orig_is_symlink = Path.is_symlink

    def fake_run(cmd, **kwargs):
        nonlocal swapped
        swapped = True
        try:
            target_dir.rmdir()
            os.symlink(outside_dir, target_dir, target_is_directory=True)
        except OSError:
            # Windows without symlink privilege: simulate symlink swap via is_symlink patch
            def swapped_is_symlink(self: Path) -> bool:
                if self == target_dir or self == target_dir.resolve():
                    return True
                return orig_is_symlink(self)

            monkeypatch.setattr(Path, "is_symlink", swapped_is_symlink)
        # Return non-zero so rollback path would normally run
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="simulated pip failure")

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=ok_resp)), patch(
        "backend.services.package_guard.subprocess.run", side_effect=fake_run
    ):
        res = asyncio.run(guard.install_package("tabulate>=0.9", target_dir))

    assert swapped is True
    assert res["ok"] is False
    assert "symlink" in (res["error"] or "").lower()
    assert precious_file.exists() and precious_file.read_text(encoding="utf-8") == "keep-me"

    # Direct calls to _rollback_new_entries and _dir_size_bytes must also reject symlinked dirs
    with pytest.raises(ValueError, match="symlink"):
        _rollback_new_entries(target_dir, set())
    with pytest.raises(ValueError, match="symlink"):
        _dir_size_bytes(target_dir)
    assert precious_file.exists()


def test_package_guard_detects_and_rejects_symlinked_entries_inside_target_dir(
    tmp_path, monkeypatch
):
    from backend.services.package_guard import _discover_installed_packages

    sandbox_dir = tmp_path / "sandbox_symentry"
    target_dir = sandbox_dir / "site-packages"
    target_dir.mkdir(parents=True)

    outside_dir = tmp_path / "outside_mod"
    outside_dir.mkdir(parents=True)
    outside_marker = outside_dir / "secret.txt"
    outside_marker.write_text("untouched", encoding="utf-8")

    # Part A: symlinked banned entry `torch` inside site-packages must NOT be skipped by discovery/banlist
    torch_link = target_dir / "torch"
    simulated_symlinks: set[Path] = set()
    orig_is_symlink = Path.is_symlink

    def make_link(link_path: Path, dest: Path, is_dir: bool) -> None:
        try:
            os.symlink(dest, link_path, target_is_directory=is_dir)
        except OSError:
            # Windows without symlink privilege: create a placeholder file (unlinkable like a real symlink)
            # and mark it as a symlink via Path.is_symlink.
            link_path.write_text("", encoding="utf-8")
            simulated_symlinks.add(link_path.resolve())
            simulated_symlinks.add(link_path)

            def patched_is_symlink(self: Path) -> bool:
                if self in simulated_symlinks and os.path.lexists(self):
                    return True
                return orig_is_symlink(self)

            monkeypatch.setattr(Path, "is_symlink", patched_is_symlink)

    guard = PackageGuard(Settings(sandbox_max_package_mb=25, sandbox_max_disk_mb=150))
    ok_resp = MagicMock(status_code=200)
    ok_resp.json.return_value = {"urls": [{"size": 10 * 1024, "packagetype": "bdist_wheel"}]}

    def fake_run_banned_link(cmd, **kwargs):
        make_link(torch_link, outside_dir, is_dir=True)
        return subprocess.CompletedProcess(cmd, 0, stdout="Successfully installed wrapper", stderr="")

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=ok_resp)), patch(
        "backend.services.package_guard.subprocess.run", side_effect=fake_run_banned_link
    ):
        res_banned = asyncio.run(guard.install_package("wrapper-pkg", target_dir))

    assert res_banned["ok"] is False
    assert "torch" in (res_banned["error"] or "").lower()
    assert not torch_link.exists() and not torch_link.is_symlink()
    assert outside_marker.exists()

    # Verify _discover_installed_packages directly catches symlinked `torch.py`
    torch_py_link = target_dir / "torch.py"
    make_link(torch_py_link, outside_marker, is_dir=False)
    assert "torch" in _discover_installed_packages(target_dir)
    if torch_py_link.is_symlink() or torch_py_link.exists():
        torch_py_link.unlink(missing_ok=True)
    simulated_symlinks.clear()

    # Part B: non-banned symlink created inside site-packages must also be rejected and rolled back
    sneaky_link = target_dir / "benign_link"

    def fake_run_benign_link(cmd, **kwargs):
        make_link(sneaky_link, outside_dir, is_dir=True)
        return subprocess.CompletedProcess(cmd, 0, stdout="Successfully installed benign", stderr="")

    with patch("httpx.AsyncClient.get", new=AsyncMock(return_value=ok_resp)), patch(
        "backend.services.package_guard.subprocess.run", side_effect=fake_run_benign_link
    ):
        res_sym = asyncio.run(guard.install_package("benign-pkg", target_dir))

    assert res_sym["ok"] is False
    assert "symlink" in (res_sym["error"] or "").lower()
    assert not sneaky_link.exists() and not sneaky_link.is_symlink()
    assert outside_marker.exists()
