"""Controlled Python package installation guard and scrubbed sandbox environment helpers."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx

from backend.config import Settings

logger = logging.getLogger(__name__)

# Standard PEP 508 package name with optional PEP 440 version specifier(s), no whitespace/flags/URLs.
_PACKAGE_SPEC_RE = re.compile(
    r"^(?P<name>[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)"
    r"(?P<version>(?:(?:===|==|!=|<=|>=|~=|<|>)[A-Za-z0-9.*_+!-]+)"
    r"(?:,(?:===|==|!=|<=|>=|~=|<|>)[A-Za-z0-9.*_+!-]+)*)?$"
)

_DISALLOWED_EXTENSIONS: tuple[str, ...] = (
    ".whl",
    ".tar.gz",
    ".tgz",
    ".tar.bz2",
    ".tar.xz",
    ".tar",
    ".zip",
    ".egg",
    ".py",
)

_DISALLOWED_SUBSTRINGS: tuple[str, ...] = (
    "://",
    "@",
    "/",
    "\\",
    "..",
    ";",
    "&",
    "|",
    "$",
    "`",
    "'",
    '"',
)

_VCS_PREFIXES: tuple[str, ...] = ("git+", "hg+", "svn+", "bzr+")

_PYPI_JSON_URL = "https://pypi.org/pypi/{package}/json"
_PIP_TIMEOUT_SECONDS = 120


def normalize_package_name(name: str) -> str:
    """Normalize a Python package name per PEP 503 (lowercase, runs of [-_.] -> '-')."""
    return re.sub(r"[-_.]+", "-", name.strip()).lower()


def ensure_safe_dir(
    path: Path,
    expected_parent: Path | None = None,
    label: str = "directory",
) -> Path:
    """Validate that ``path`` is not a symlink and resolves directly under ``expected_parent``."""
    raw = Path(path)
    if raw.is_symlink():
        raise ValueError(f"Refusing to use symlinked {label}: {raw}")
    if raw.exists() and not raw.is_dir():
        raise ValueError(f"Expected a directory for {label}, found non-directory: {raw}")

    resolved = raw.resolve()
    if expected_parent is not None:
        raw_parent = Path(expected_parent)
        if raw_parent.is_symlink():
            raise ValueError(f"Refusing to use symlinked parent for {label}: {raw_parent}")
        resolved_parent = raw_parent.resolve()
        if resolved.parent != resolved_parent:
            raise ValueError(
                f"Resolved {label} path escapes expected parent directory: {resolved}"
            )
    return resolved


def build_scrubbed_env(
    sandbox_dir: Path,
    site_packages_dir: Path,
    tmp_dir: Path | None = None,
) -> dict[str, str]:
    """Build a strictly allowlisted environment with zero app/cloud/LLM/admin secrets."""
    resolved_sandbox = ensure_safe_dir(Path(sandbox_dir), label="sandbox directory")
    resolved_site = ensure_safe_dir(Path(site_packages_dir), label="site-packages directory")
    raw_tmp = Path(tmp_dir) if tmp_dir is not None else (resolved_sandbox / "tmp")
    resolved_tmp = ensure_safe_dir(raw_tmp, label="temporary directory")
    resolved_tmp.mkdir(parents=True, exist_ok=True)

    env: dict[str, str] = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": str(resolved_sandbox),
        "TMPDIR": str(resolved_tmp),
        "PYTHONPATH": str(resolved_site),
        "MPLBACKEND": "Agg",
        "MPLCONFIGDIR": str(resolved_tmp),
        "PYTHONNOUSERSITE": "1",
        "PYTHONIOENCODING": "utf-8",
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
    }

    if os.name == "nt":
        for win_key in ("SYSTEMROOT", "WINDIR"):
            val = os.environ.get(win_key)
            if val:
                env[win_key] = val
        env["TEMP"] = str(resolved_tmp)
        env["TMP"] = str(resolved_tmp)
        env["USERPROFILE"] = str(resolved_sandbox)

    return env


def resolve_sandbox_user(settings: Settings) -> tuple[str | None, int | None, int | None]:
    """Resolve an unprivileged POSIX user for subprocess isolation if permitted.

    Returns ``(username, uid, gid)`` when privilege drop is applicable and supported,
    or ``(None, None, None)`` on Windows or unprivileged local development.
    """
    if os.name == "nt":
        return (None, None, None)

    try:
        import pwd  # POSIX-only stdlib module
    except ImportError:
        return (None, None, None)

    geteuid = getattr(os, "geteuid", None)
    if geteuid is None:
        return (None, None, None)

    current_uid = geteuid()
    configured = settings.sandbox_os_user.strip()

    if current_uid == 0:
        target = configured or "sandbox"
        try:
            pw = pwd.getpwnam(target)
            return (target, pw.pw_uid, pw.pw_gid)
        except KeyError:
            if configured:
                logger.warning("Configured SANDBOX_OS_USER '%s' does not exist.", configured)
            return (None, None, None)

    if configured:
        try:
            pw = pwd.getpwnam(configured)
            if pw.pw_uid == current_uid:
                return (configured, pw.pw_uid, pw.pw_gid)
            logger.debug(
                "Skipping user drop to '%s': process is non-root (uid=%d).",
                configured,
                current_uid,
            )
        except KeyError:
            logger.warning("Configured SANDBOX_OS_USER '%s' does not exist.", configured)

    return (None, None, None)


def _dir_size_bytes(directory: Path, expected_parent: Path | None = None) -> int:
    """Compute total regular-file bytes inside ``directory`` without following symlinks."""
    safe_dir = ensure_safe_dir(
        directory,
        expected_parent=expected_parent if expected_parent is not None else Path(directory).parent,
        label="target directory",
    )
    total = 0
    if not safe_dir.exists():
        return 0
    for root, _dirs, files in os.walk(safe_dir, followlinks=False):
        for fname in files:
            fpath = os.path.join(root, fname)
            try:
                if not os.path.islink(fpath):
                    total += os.path.getsize(fpath)
            except OSError:
                continue
    return total


def _snapshot_entries(directory: Path, expected_parent: Path | None = None) -> set[Path]:
    """Capture all relative file and directory paths currently inside ``directory``."""
    safe_dir = ensure_safe_dir(
        directory,
        expected_parent=expected_parent if expected_parent is not None else Path(directory).parent,
        label="target directory",
    )
    entries: set[Path] = set()
    if not safe_dir.exists():
        return entries
    for root, dirs, files in os.walk(safe_dir, followlinks=False):
        rel_root = Path(root).relative_to(safe_dir)
        for d in dirs:
            entries.add(rel_root / d)
        for f in files:
            entries.add(rel_root / f)
    return entries


def _rollback_new_entries(
    directory: Path,
    before_entries: set[Path],
    expected_parent: Path | None = None,
) -> None:
    """Delete files and directories added to ``directory`` since ``before_entries``.

    Refuses to walk or delete anything if ``directory`` or its parent has been replaced
    with a symlink.
    """
    safe_dir = ensure_safe_dir(
        directory,
        expected_parent=expected_parent if expected_parent is not None else Path(directory).parent,
        label="target directory",
    )
    if not safe_dir.exists():
        return
    # Remove newly created files first, then newly created directories deepest-first.
    new_dirs: list[Path] = []
    for root, dirs, files in os.walk(safe_dir, topdown=False, followlinks=False):
        rel_root = Path(root).relative_to(safe_dir)
        for f in files:
            rel_path = rel_root / f
            if rel_path not in before_entries:
                try:
                    (safe_dir / rel_path).unlink(missing_ok=True)
                except OSError:
                    pass
        for d in dirs:
            rel_path = rel_root / d
            if rel_path not in before_entries:
                new_dirs.append(safe_dir / rel_path)

    for dpath in new_dirs:
        if dpath.is_symlink():
            try:
                dpath.unlink(missing_ok=True)
            except OSError:
                pass
        else:
            shutil.rmtree(dpath, ignore_errors=True)


def _find_symlinks(directory: Path, expected_parent: Path | None = None) -> list[Path]:
    """Return any symlink entries (files or directories) found inside ``directory``."""
    safe_dir = ensure_safe_dir(
        directory,
        expected_parent=expected_parent if expected_parent is not None else Path(directory).parent,
        label="target directory",
    )
    found: list[Path] = []
    if not safe_dir.exists():
        return found
    for root, dirs, files in os.walk(safe_dir, followlinks=False):
        root_path = Path(root)
        for d in dirs:
            candidate = root_path / d
            if candidate.is_symlink():
                found.append(candidate)
        for f in files:
            candidate = root_path / f
            if candidate.is_symlink():
                found.append(candidate)
    return found


def _discover_installed_packages(
    directory: Path,
    expected_parent: Path | None = None,
) -> set[str]:
    """Return all normalized distribution and module names found inside ``directory``.

    Includes symlinked top-level entries by name without dereferencing their targets.
    """
    safe_dir = ensure_safe_dir(
        directory,
        expected_parent=expected_parent if expected_parent is not None else Path(directory).parent,
        label="target directory",
    )
    found: set[str] = set()
    if not safe_dir.exists():
        return found

    for child in safe_dir.iterdir():
        if child.is_symlink():
            if child.name.endswith(".dist-info"):
                stem = child.name[: -len(".dist-info")]
                prefix = stem.split("-", 1)[0]
                if prefix:
                    found.add(normalize_package_name(prefix))
            elif child.suffix == ".py" and not child.name.startswith("."):
                found.add(normalize_package_name(child.stem))
            elif not child.name.startswith(".") and child.name != "__pycache__":
                found.add(normalize_package_name(child.name))
            continue

        if child.is_dir() and child.name.endswith(".dist-info"):
            meta = child / "METADATA"
            parsed_name: str | None = None
            if meta.is_file() and not meta.is_symlink():
                try:
                    for line in meta.read_text(encoding="utf-8", errors="replace").splitlines():
                        if line.lower().startswith("name:"):
                            parsed_name = line.split(":", 1)[1].strip()
                            break
                        if line == "":
                            break
                except OSError:
                    pass
            if parsed_name:
                found.add(normalize_package_name(parsed_name))
            else:
                stem = child.name[: -len(".dist-info")]
                prefix = stem.split("-", 1)[0]
                if prefix:
                    found.add(normalize_package_name(prefix))
        elif child.is_dir() and not child.name.startswith(".") and child.name != "__pycache__":
            found.add(normalize_package_name(child.name))
        elif child.is_file() and child.suffix == ".py" and not child.name.startswith("."):
            found.add(normalize_package_name(child.stem))

    return found


class PackageGuard:
    """Validates PyPI package specs, checks download size, and performs isolated installs."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._banned_packages: set[str] = {
            normalize_package_name(pkg) for pkg in settings.banned_package_set
        }

    def validate_package_spec(self, spec: str) -> tuple[str, str]:
        """Validate a package spec and return ``(normalized_name, clean_spec)``.

        Raises ``ValueError`` for banned packages, URLs/VCS/local paths, flags, or invalid syntax.
        """
        if not isinstance(spec, str):
            raise ValueError("Package specification must be a string.")

        cleaned = spec.strip()
        if not cleaned:
            raise ValueError("Package specification cannot be empty.")

        if any(ch.isspace() for ch in cleaned):
            raise ValueError("Package specification must not contain spaces or extra flags.")

        if cleaned.startswith("-"):
            raise ValueError("Pip flags and options are not allowed in package specifications.")

        lowered = cleaned.lower()
        if any(lowered.startswith(prefix) for prefix in _VCS_PREFIXES):
            raise ValueError("VCS package URLs are not allowed.")

        if any(sub in cleaned for sub in _DISALLOWED_SUBSTRINGS):
            raise ValueError("URLs, direct references, and local paths are not allowed.")

        if any(lowered.endswith(ext) for ext in _DISALLOWED_EXTENSIONS):
            raise ValueError("Local archive or wheel files are not allowed.")

        match = _PACKAGE_SPEC_RE.match(cleaned)
        if not match:
            raise ValueError(
                f"Invalid package specification '{cleaned}'. Only standard PyPI names and version specifiers are allowed."
            )

        raw_name = match.group("name")
        normalized = normalize_package_name(raw_name)

        if normalized in self._banned_packages:
            raise ValueError(
                f"Package '{normalized}' is blocked by sandbox policy."
            )

        return (normalized, cleaned)

    async def check_pypi_size(self, package_name: str) -> float:
        """Query PyPI JSON metadata and return max wheel/sdist size in MB.

        Raises ``ValueError`` if the package is missing, unreachable, or exceeds
        ``settings.sandbox_max_package_mb``.
        """
        normalized, _ = self.validate_package_spec(package_name)
        url = _PYPI_JSON_URL.format(package=normalized)

        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                resp = await client.get(url)
        except httpx.HTTPError as exc:
            raise ValueError(f"Failed to query PyPI metadata for '{normalized}': {exc}") from exc

        if resp.status_code == 404:
            raise ValueError(f"Package '{normalized}' was not found on PyPI (404).")
        if resp.status_code >= 400:
            raise ValueError(
                f"PyPI metadata request failed for '{normalized}' (HTTP {resp.status_code})."
            )

        try:
            payload: dict[str, Any] = resp.json()
        except ValueError as exc:
            raise ValueError(f"Invalid JSON metadata returned from PyPI for '{normalized}'.") from exc

        urls = payload.get("urls") or []
        if not urls and isinstance(payload.get("releases"), dict):
            # Fallback to the latest non-empty release list if top-level urls is empty
            for release_files in reversed(list(payload["releases"].values())):
                if release_files:
                    urls = release_files
                    break

        relevant = [
            entry
            for entry in urls
            if isinstance(entry, dict)
            and entry.get("packagetype") in ("bdist_wheel", "sdist")
            and isinstance(entry.get("size"), (int, float))
        ]
        if not relevant:
            relevant = [
                entry
                for entry in urls
                if isinstance(entry, dict) and isinstance(entry.get("size"), (int, float))
            ]

        max_bytes = max((int(entry["size"]) for entry in relevant), default=0)
        size_mb = round(max_bytes / (1024 * 1024), 2)

        if size_mb > self.settings.sandbox_max_package_mb:
            raise ValueError(
                f"Package '{normalized}' size ({size_mb:.2f} MB) exceeds the "
                f"{self.settings.sandbox_max_package_mb} MB sandbox package limit."
            )

        return size_mb

    async def install_package(self, spec: str, target_dir: Path) -> dict[str, Any]:
        """Validate, size-check, and install a PyPI package into ``target_dir`` with rollback."""
        raw_label = spec.strip() if isinstance(spec, str) else ""
        try:
            normalized_name, clean_spec = self.validate_package_spec(spec)
        except ValueError as exc:
            return {
                "ok": False,
                "package": raw_label,
                "size_mb": 0.0,
                "output": "",
                "error": str(exc),
            }

        try:
            pypi_size_mb = await self.check_pypi_size(normalized_name)
        except ValueError as exc:
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": 0.0,
                "output": "",
                "error": str(exc),
            }

        raw_target = Path(target_dir)
        try:
            sandbox_dir = ensure_safe_dir(raw_target.parent, label="sandbox directory")
            resolved_target = ensure_safe_dir(
                raw_target,
                expected_parent=raw_target.parent,
                label="target site-packages directory",
            )
            tmp_dir = ensure_safe_dir(
                sandbox_dir / "tmp",
                expected_parent=sandbox_dir,
                label="sandbox temporary directory",
            )
        except ValueError as exc:
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": 0.0,
                "output": "",
                "error": str(exc),
            }

        resolved_target.mkdir(parents=True, exist_ok=True)
        tmp_dir.mkdir(parents=True, exist_ok=True)

        current_mb = _dir_size_bytes(resolved_target) / (1024 * 1024)
        if current_mb >= self.settings.sandbox_max_disk_mb:
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": round(current_mb, 2),
                "output": "",
                "error": (
                    f"Sandbox disk limit already reached ({current_mb:.2f} MB / "
                    f"{self.settings.sandbox_max_disk_mb} MB)."
                ),
            }

        before_entries = _snapshot_entries(resolved_target)
        env = build_scrubbed_env(
            sandbox_dir=sandbox_dir,
            site_packages_dir=resolved_target,
            tmp_dir=tmp_dir,
        )

        cmd = [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-cache-dir",
            "--disable-pip-version-check",
            "--target",
            str(resolved_target),
            "--",
            clean_spec,
        ]

        popen_kwargs: dict[str, Any] = {
            "cwd": str(sandbox_dir),
            "env": env,
            "capture_output": True,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "timeout": _PIP_TIMEOUT_SECONDS,
        }
        sandbox_user, _, _ = resolve_sandbox_user(self.settings)
        if sandbox_user is not None:
            popen_kwargs["user"] = sandbox_user

        def _revalidate_target() -> Path:
            ensure_safe_dir(raw_target.parent, label="sandbox directory")
            checked = ensure_safe_dir(
                raw_target,
                expected_parent=raw_target.parent,
                label="target site-packages directory",
            )
            if checked != resolved_target:
                raise ValueError("Target site-packages directory changed during installation.")
            return checked

        def _safe_rollback() -> str | None:
            try:
                _revalidate_target()
                _rollback_new_entries(
                    raw_target,
                    before_entries,
                    expected_parent=raw_target.parent,
                )
                return None
            except ValueError as sec_exc:
                return str(sec_exc)

        try:
            proc = await asyncio.to_thread(subprocess.run, cmd, **popen_kwargs)
        except subprocess.TimeoutExpired:
            sec_err = _safe_rollback()
            err = (
                f"Package installation timed out after {_PIP_TIMEOUT_SECONDS}s "
                f"({sec_err})."
                if sec_err
                else f"Package installation timed out after {_PIP_TIMEOUT_SECONDS}s and was rolled back."
            )
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": pypi_size_mb,
                "output": "",
                "error": err,
            }
        except OSError as exc:
            sec_err = _safe_rollback()
            err = f"Failed to launch pip: {exc}" + (f" ({sec_err})" if sec_err else "")
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": pypi_size_mb,
                "output": "",
                "error": err,
            }

        combined_output = "\n".join(
            part for part in ((proc.stdout or "").strip(), (proc.stderr or "").strip()) if part
        )

        # Immediately re-validate target_dir and its parent after pip exits to prevent
        # TOCTOU symlink swaps before rollback, discovery, or disk-size scans.
        try:
            _revalidate_target()
        except ValueError as sec_exc:
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": 0.0,
                "output": combined_output,
                "error": str(sec_exc),
            }

        if proc.returncode != 0:
            sec_err = _safe_rollback()
            err = sec_err or combined_output or f"pip exited with status {proc.returncode}."
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": pypi_size_mb,
                "output": combined_output,
                "error": err,
            }

        # Check all installed packages (including transitive dependencies, pre-created
        # directories, and symlinked top-level entries) against the banlist.
        try:
            installed_packages = _discover_installed_packages(
                raw_target, expected_parent=raw_target.parent
            )
        except ValueError as sec_exc:
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": 0.0,
                "output": combined_output,
                "error": str(sec_exc),
            }

        banned_found = sorted(installed_packages & self._banned_packages)
        if banned_found:
            sec_err = _safe_rollback()
            banned_str = ", ".join(banned_found)
            err = (
                f"Installation aborted and rolled back: blocked transitive dependency "
                f"detected ({banned_str})."
            )
            if sec_err:
                err = f"{err} ({sec_err})"
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": pypi_size_mb,
                "output": combined_output,
                "error": err,
            }

        # Reject any symlink entries inside site-packages (blocks symlink bypass tricks).
        try:
            symlinks_found = _find_symlinks(raw_target, expected_parent=raw_target.parent)
        except ValueError as sec_exc:
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": 0.0,
                "output": combined_output,
                "error": str(sec_exc),
            }

        if symlinks_found:
            sec_err = _safe_rollback()
            err = "Installation aborted and rolled back: symlinks are not allowed inside sandbox site-packages."
            if sec_err:
                err = f"{err} ({sec_err})"
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": pypi_size_mb,
                "output": combined_output,
                "error": err,
            }

        # Enforce total per-session disk budget
        try:
            after_mb = (
                _dir_size_bytes(raw_target, expected_parent=raw_target.parent)
                / (1024 * 1024)
            )
        except ValueError as sec_exc:
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": 0.0,
                "output": combined_output,
                "error": str(sec_exc),
            }

        if after_mb > self.settings.sandbox_max_disk_mb:
            sec_err = _safe_rollback()
            err = (
                f"Installation exceeded sandbox disk limit ({after_mb:.2f} MB > "
                f"{self.settings.sandbox_max_disk_mb} MB) and was rolled back."
            )
            if sec_err:
                err = f"{err} ({sec_err})"
            return {
                "ok": False,
                "package": normalized_name,
                "size_mb": round(after_mb, 2),
                "output": combined_output,
                "error": err,
            }

        return {
            "ok": True,
            "package": normalized_name,
            "size_mb": round(max(pypi_size_mb, after_mb - current_mb), 2),
            "output": combined_output,
            "error": None,
        }
