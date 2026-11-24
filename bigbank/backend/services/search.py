"""SSRF-hardened open-book DuckDuckGo search and web page proxy service."""

from __future__ import annotations

import html
import ipaddress
import re
import socket
from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup

ALLOWED_SCHEMES: frozenset[str] = frozenset({"http", "https"})
MAX_REDIRECTS: int = 5
MAX_PROXY_BYTES: int = 5 * 1024 * 1024  # 5 MB
PROXY_TIMEOUT_SECONDS: float = 10.0

_REDIRECT_STATUS_CODES: frozenset[int] = frozenset({301, 302, 303, 307, 308})
_HEAD_TAG_RE = re.compile(r"<head(?:\s[^>]*)?>", re.IGNORECASE)
_DEFAULT_HEADERS: dict[str, str] = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

_BLOCKED_NETWORKS: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...] = (
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),   # CGNAT (RFC 6598)
    ipaddress.ip_network("127.0.0.0/8"),     # IPv4 loopback
    ipaddress.ip_network("169.254.0.0/16"),  # Link-local / cloud metadata
    ipaddress.ip_network("172.16.0.0/12"),   # RFC 1918 private
    ipaddress.ip_network("192.168.0.0/16"),  # RFC 1918 private
    ipaddress.ip_network("::1/128"),         # IPv6 loopback
    ipaddress.ip_network("fc00::/7"),        # IPv6 unique local (ULA)
    ipaddress.ip_network("fe80::/10"),       # IPv6 link-local
)


def _is_public_ip_obj(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        if not _is_public_ip_obj(ip.ipv4_mapped):
            return False

    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or not ip.is_global
    ):
        return False

    for net in _BLOCKED_NETWORKS:
        if ip.version == net.version and ip in net:
            return False

    return True


def _is_public_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address((ip_str or "").strip())
    except ValueError:
        return False
    return _is_public_ip_obj(ip)


def _resolve_ips(host: str) -> list[str]:
    """Resolve a hostname to a deduplicated list of IP address strings via DNS."""
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, OSError) as exc:
        raise ValueError(f"Could not resolve hostname '{host}': {exc}") from exc

    ips: list[str] = []
    seen: set[str] = set()
    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        addr = str(sockaddr[0])
        if addr not in seen:
            seen.add(addr)
            ips.append(addr)
    return ips


def validate_public_url(url: str) -> str:
    """Validate that a URL uses http/https and resolves exclusively to public global IPs."""
    if not isinstance(url, str):
        raise ValueError("URL must be a string")

    cleaned = url.strip()
    if not cleaned:
        raise ValueError("URL cannot be empty")
    if any(ch in cleaned for ch in ("\r", "\n", "\t", "\x00")):
        raise ValueError("URL contains forbidden control characters")

    parsed = urlsplit(cleaned)
    scheme = (parsed.scheme or "").lower()
    if scheme not in ALLOWED_SCHEMES:
        raise ValueError(f"Disallowed URL scheme '{scheme or '(none)'}'; only http and https are allowed")

    host = parsed.hostname
    if not host:
        raise ValueError("URL must include a valid hostname")

    # Accessing parsed.port validates numeric range (1..65535) and raises ValueError if invalid.
    _ = parsed.port

    host_lower = host.rstrip(".").lower()
    if host_lower == "localhost" or host_lower.endswith(".localhost"):
        raise ValueError(f"Blocked internal hostname: '{host}'")

    # If the host is an IP literal, validate it directly before touching DNS.
    try:
        ip_literal = ipaddress.ip_address(host)
    except ValueError:
        ip_literal = None

    if ip_literal is not None:
        if not _is_public_ip_obj(ip_literal):
            raise ValueError(f"Blocked non-public IP address: {host}")
        return cleaned

    resolved = _resolve_ips(host)
    if not resolved:
        raise ValueError(f"Hostname '{host}' did not resolve to any IP address")

    for ip_str in resolved:
        if not _is_public_ip(ip_str):
            raise ValueError(
                f"Blocked non-public IP address '{ip_str}' resolved for host '{host}'"
            )

    return cleaned


def _get_header(headers: Mapping[str, Any], name: str) -> str:
    target = name.lower()
    for key, value in headers.items():
        if str(key).lower() == target:
            return str(value)
    return ""


def _inject_base_href(html_text: str, final_url: str) -> str:
    base_tag = f'<base href="{html.escape(final_url, quote=True)}">'
    match = _HEAD_TAG_RE.search(html_text)
    if match:
        insert_at = match.end()
        return f"{html_text[:insert_at]}{base_tag}{html_text[insert_at:]}"
    return f"{base_tag}{html_text}"


def _extract_ddg_link(raw_href: str) -> str:
    href = (raw_href or "").strip()
    if not href:
        return ""
    if href.startswith("//"):
        href = f"https:{href}"
    if "uddg=" in href:
        qs = parse_qs(urlsplit(href).query)
        uddg_vals = qs.get("uddg")
        if uddg_vals and uddg_vals[0]:
            href = unquote(uddg_vals[0])
        else:
            match = re.search(r"uddg=([^&]+)", href)
            if match:
                href = unquote(match.group(1))
    scheme = urlsplit(href).scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        return ""
    return href


async def search_duckduckgo(query: str) -> dict[str, Any]:
    """Fetch open-book web search results from DuckDuckGo's HTML endpoint."""
    cleaned = (query or "").strip()
    if not cleaned:
        return {
            "results": [],
            "search_url": "https://duckduckgo.com/",
            "error": None,
        }

    search_url = f"https://duckduckgo.com/?q={quote_plus(cleaned)}"
    ddg_endpoint = "https://html.duckduckgo.com/html/"

    try:
        async with httpx.AsyncClient(
            timeout=PROXY_TIMEOUT_SECONDS,
            follow_redirects=True,
        ) as client:
            response = await client.post(
                ddg_endpoint,
                data={"q": cleaned},
                headers=_DEFAULT_HEADERS,
            )
            if response.status_code not in (200, 202):
                response = await client.get(
                    ddg_endpoint,
                    params={"q": cleaned},
                    headers=_DEFAULT_HEADERS,
                )

        soup = BeautifulSoup(response.text, "html.parser")
        results: list[dict[str, str]] = []
        for block in soup.find_all("div", class_="result"):
            title_tag = block.find("a", class_="result__a")
            if not title_tag:
                continue
            link = _extract_ddg_link(str(title_tag.get("href") or ""))
            if not link:
                continue
            title = title_tag.get_text(" ", strip=True)
            snippet_tag = block.find(class_="result__snippet")
            snippet = snippet_tag.get_text(" ", strip=True) if snippet_tag else ""
            results.append(
                {
                    "title": title,
                    "url": link,
                    "snippet": snippet,
                }
            )
            if len(results) >= 10:
                break

        return {
            "results": results,
            "search_url": search_url,
            "error": None,
        }
    except Exception as exc:
        return {
            "results": [],
            "search_url": search_url,
            "error": str(exc),
        }


async def _read_capped_response(response: Any, current_url: str) -> tuple[bytes, str, int]:
    """Stream response bytes with a strict 5 MB cap, rejecting oversized payloads immediately."""
    content_length_raw = _get_header(response.headers, "content-length").strip()
    if content_length_raw:
        try:
            declared_size: int | None = int(content_length_raw)
        except ValueError:
            declared_size = None
        if declared_size is not None and declared_size > MAX_PROXY_BYTES:
            raise ValueError("Proxied response exceeds 5 MB limit")

    buf = bytearray()
    async for chunk in response.aiter_bytes():
        if not chunk:
            continue
        if len(buf) + len(chunk) > MAX_PROXY_BYTES:
            raise ValueError("Proxied response exceeds 5 MB limit")
        buf.extend(chunk)
    raw_bytes = bytes(buf)

    content_type = (
        _get_header(response.headers, "content-type").strip()
        or "application/octet-stream"
    )
    ct_lower = content_type.lower()
    if "text/html" in ct_lower or "application/xhtml+xml" in ct_lower:
        encoding = getattr(response, "charset_encoding", None)
        if not isinstance(encoding, str) or not encoding.strip():
            encoding = "utf-8"
        try:
            html_text = raw_bytes.decode(encoding, errors="replace")
        except LookupError:
            html_text = raw_bytes.decode("utf-8", errors="replace")
        rewritten = _inject_base_href(html_text, current_url)
        return rewritten.encode("utf-8"), content_type, int(response.status_code)

    return raw_bytes, content_type, int(response.status_code)


async def fetch_proxied_url(url: str) -> tuple[bytes, str, int]:
    """Fetch a public URL with SSRF protection on every redirect hop and a 5 MB cap."""
    current_url = validate_public_url(url)

    async with httpx.AsyncClient(
        timeout=PROXY_TIMEOUT_SECONDS,
        follow_redirects=False,
    ) as client:
        for hop in range(MAX_REDIRECTS + 1):
            async with client.stream(
                "GET", current_url, headers=_DEFAULT_HEADERS
            ) as response:
                status = int(response.status_code)
                if status in _REDIRECT_STATUS_CODES:
                    location = _get_header(response.headers, "location").strip()
                    if not location:
                        return await _read_capped_response(response, current_url)
                    if hop >= MAX_REDIRECTS:
                        raise ValueError(
                            f"Too many redirects (exceeded maximum of {MAX_REDIRECTS} hops)"
                        )
                    next_url = urljoin(current_url, location)
                    current_url = validate_public_url(next_url)
                    continue
                return await _read_capped_response(response, current_url)

    raise ValueError(f"Too many redirects (exceeded maximum of {MAX_REDIRECTS} hops)")
