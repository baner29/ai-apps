"""Standalone stateful Python notebook kernel worker communicating via JSON-lines over stdio.

Uses only the Python standard library at import time so it can execute cleanly under
an unprivileged OS user even when the parent application directory is unreadable.
"""

from __future__ import annotations

import argparse
import ast
import base64
import contextlib
import importlib
import io
import json
import os
import sys
import traceback
from typing import Any

_MAX_TEXT_OUTPUT_CHARS = 512 * 1024
_MAX_HTML_OUTPUT_CHARS = 2 * 1024 * 1024


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n... [output truncated]"


def _apply_posix_limits(max_memory_mb: int) -> None:
    """Apply POSIX virtual memory limit when running on Linux/Unix."""
    if os.name == "nt" or max_memory_mb <= 0:
        return
    try:
        import resource  # POSIX-only stdlib module
    except ImportError:
        return

    limit_bytes = int(max_memory_mb) * 1024 * 1024
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        if hard == resource.RLIM_INFINITY:
            new_soft = limit_bytes
            new_hard = limit_bytes
        else:
            new_soft = min(limit_bytes, hard)
            new_hard = hard
        resource.setrlimit(resource.RLIMIT_AS, (new_soft, new_hard))
    except (ValueError, OSError):
        # Some container runtimes disallow tightening RLIMIT_AS; continue gracefully.
        pass


def _harden_sys_path(site_packages: str | None) -> None:
    """Remove worker/application directories from sys.path and prioritize session site-packages."""
    script_dir = os.path.abspath(os.path.dirname(__file__))
    cwd = os.path.abspath(os.getcwd())
    resolved_site = os.path.abspath(site_packages) if site_packages else None

    # Identify paths to strip: the script's directory and (if invoked via -m backend.services...)
    # its ancestor project root when that root differs from cwd.
    blocked_dirs = {script_dir}
    parent_dir = os.path.dirname(script_dir)
    grandparent_dir = os.path.dirname(parent_dir)
    if os.path.basename(script_dir) == "services" and os.path.basename(parent_dir) == "backend":
        blocked_dirs.add(parent_dir)
        blocked_dirs.add(grandparent_dir)

    cleaned_path: list[str] = []
    for entry in sys.path:
        if entry == "":
            # Empty string means cwd; keep cwd only if it is not blocked.
            if cwd not in blocked_dirs:
                cleaned_path.append(cwd)
            continue
        abs_entry = os.path.abspath(entry)
        if abs_entry in blocked_dirs and abs_entry != resolved_site:
            continue
        if abs_entry not in cleaned_path:
            cleaned_path.append(abs_entry)

    if resolved_site:
        cleaned_path = [p for p in cleaned_path if p != resolved_site]
        cleaned_path.insert(0, resolved_site)

    sys.path[:] = cleaned_path
    sys.argv = ["notebook"]


def _format_cell_traceback(exc: BaseException) -> str:
    """Format an exception traceback focusing on user ``<cell>`` frames."""
    tb = exc.__traceback__
    extracted = traceback.extract_tb(tb) if tb is not None else []
    cell_frames = [frame for frame in extracted if frame.filename == "<cell>"]
    if cell_frames:
        lines = ["Traceback (most recent call last):"]
        lines.extend(traceback.format_list(cell_frames))
        lines.extend(traceback.format_exception_only(type(exc), exc))
        return "".join(lines).rstrip()
    return "".join(traceback.format_exception_only(type(exc), exc)).rstrip()


def _capture_matplotlib_png() -> str | None:
    """Capture the active matplotlib figure as base64 PNG and close all open figures."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return None
    try:
        fig_nums = plt.get_fignums()
        if not fig_nums:
            return None
        fig = plt.figure(fig_nums[-1])
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight", dpi=110)
        buf.seek(0)
        encoded = base64.b64encode(buf.read()).decode("ascii")
        plt.close("all")
        return encoded
    except Exception:
        try:
            plt.close("all")
        except Exception:
            pass
        return None


def _execute_code(
    code: str,
    namespace: dict[str, Any],
    execution_count: int,
) -> dict[str, Any]:
    """Execute one cell of Python code in ``namespace`` and return structured output."""
    importlib.invalidate_caches()

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    html_output: str | None = None
    image_png_base64: str | None = None
    error_text: str | None = None
    ok = True

    stripped_code = code.rstrip()
    suppress_repr = stripped_code.endswith(";")

    try:
        tree = ast.parse(code, filename="<cell>", mode="exec")
    except SyntaxError as exc:
        return {
            "ok": False,
            "execution_count": execution_count,
            "stdout": "",
            "stderr": "",
            "html": None,
            "image_png_base64": None,
            "error": _format_cell_traceback(exc),
        }

    with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
        try:
            if tree.body:
                last_node = tree.body[-1]
                if isinstance(last_node, ast.Expr):
                    init_nodes = tree.body[:-1]
                    if init_nodes:
                        init_mod = ast.Module(body=init_nodes, type_ignores=[])
                        ast.fix_missing_locations(init_mod)
                        exec(compile(init_mod, "<cell>", "exec"), namespace)

                    expr_mod = ast.Expression(body=last_node.value)
                    ast.fix_missing_locations(expr_mod)
                    last_value = eval(compile(expr_mod, "<cell>", "eval"), namespace)

                    if last_value is not None:
                        namespace["_"] = last_value
                        repr_html_fn = getattr(last_value, "_repr_html_", None)
                        if callable(repr_html_fn):
                            try:
                                candidate_html = repr_html_fn()
                                if isinstance(candidate_html, str) and candidate_html.strip():
                                    html_output = _truncate(candidate_html, _MAX_HTML_OUTPUT_CHARS)
                            except Exception:
                                html_output = None

                        if html_output is None and not suppress_repr:
                            try:
                                stdout_buf.write(repr(last_value) + "\n")
                            except Exception:
                                pass
                else:
                    exec(compile(tree, "<cell>", "exec"), namespace)
        except BaseException as exc:
            if isinstance(exc, KeyboardInterrupt):
                ok = False
                error_text = "KeyboardInterrupt: execution interrupted."
            elif isinstance(exc, SystemExit):
                ok = False
                error_text = f"SystemExit: {exc.code}"
            else:
                ok = False
                error_text = _format_cell_traceback(exc)
        finally:
            image_png_base64 = _capture_matplotlib_png()

    return {
        "ok": ok,
        "execution_count": execution_count,
        "stdout": _truncate(stdout_buf.getvalue(), _MAX_TEXT_OUTPUT_CHARS),
        "stderr": _truncate(stderr_buf.getvalue(), _MAX_TEXT_OUTPUT_CHARS),
        "html": html_output,
        "image_png_base64": image_png_base64,
        "error": error_text,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Stateful Python notebook kernel worker")
    parser.add_argument("--site-packages", dest="site_packages", default="")
    parser.add_argument("--max-memory-mb", dest="max_memory_mb", type=int, default=0)
    args = parser.parse_args(argv)

    os.environ.setdefault("MPLBACKEND", "Agg")
    _harden_sys_path(args.site_packages or os.environ.get("PYTHONPATH") or None)

    mem_mb = args.max_memory_mb
    if mem_mb <= 0:
        try:
            mem_mb = int(os.environ.get("SANDBOX_MAX_MEMORY_MB", "0") or "0")
        except ValueError:
            mem_mb = 0
    _apply_posix_limits(mem_mb)

    proto_in = sys.stdin

    # Isolate the JSON-lines protocol channel off fd 1 so candidate code writing
    # directly to sys.__stdout__ or raw fd 1 cannot corrupt protocol framing.
    try:
        sys.stdout.flush()
    except Exception:
        pass

    devnull_stream = None
    try:
        proto_fd = os.dup(1)
        devnull_fd = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(devnull_fd, 1)
        finally:
            os.close(devnull_fd)
        proto_out = os.fdopen(proto_fd, "w", encoding="utf-8", buffering=1)
        devnull_stream = open(os.devnull, "w", encoding="utf-8")
        sys.stdout = devnull_stream
        sys.__stdout__ = devnull_stream
    except OSError:
        proto_out = sys.stdout

    namespace: dict[str, Any] = {
        "__name__": "__main__",
        "__builtins__": __builtins__,
    }
    execution_count = 0

    try:
        for raw_line in proto_in:
            line = raw_line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                resp = {
                    "ok": False,
                    "execution_count": execution_count,
                    "stdout": "",
                    "stderr": "",
                    "html": None,
                    "image_png_base64": None,
                    "error": f"Invalid worker request JSON: {exc}",
                }
                proto_out.write(json.dumps(resp) + "\n")
                proto_out.flush()
                continue

            if isinstance(req, dict) and req.get("op") == "ping":
                proto_out.write(json.dumps({"ok": True, "pong": True}) + "\n")
                proto_out.flush()
                continue

            code = req.get("code", "") if isinstance(req, dict) else ""
            if not isinstance(code, str):
                code = str(code)

            execution_count += 1
            resp = _execute_code(code, namespace, execution_count)
            proto_out.write(json.dumps(resp) + "\n")
            proto_out.flush()
    finally:
        try:
            proto_out.flush()
            if proto_out is not sys.stdout:
                proto_out.close()
        except OSError:
            pass
        if devnull_stream is not None:
            try:
                devnull_stream.close()
            except OSError:
                pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
