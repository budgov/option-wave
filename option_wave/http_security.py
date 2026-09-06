"""Small HTTPS/origin policy shared by read-only market-data adapters."""

from __future__ import annotations

from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, build_opener


class HTTPURLPolicyError(ValueError):
    """A request target violates the credential transport boundary."""


def _check_text(value: str) -> None:
    if not isinstance(value, str) or not value or any(
        ord(character) <= 32 or ord(character) == 127 or character == "\\"
        for character in value
    ):
        raise HTTPURLPolicyError("market-data URL contains invalid characters")


def https_origin(url: str) -> tuple[str, str, int]:
    """Validate before URL normalization; never echo credential-bearing URLs."""
    _check_text(url)
    try:
        parts = urlsplit(url)
        port = parts.port
        hostname = parts.hostname
    except ValueError:
        raise HTTPURLPolicyError("market-data URL is malformed") from None
    if (
        parts.scheme.lower() != "https" or not hostname
        or parts.username is not None or parts.password is not None
        or parts.fragment or "%" in hostname or port == 0
    ):
        raise HTTPURLPolicyError("market-data URLs require HTTPS without user information or fragments")
    return "https", hostname.lower(), 443 if port is None else port


def resolve_https_url(base_url: str, reference: str, *, relative_to: str | None = None) -> str:
    """Allow relative links and explicit default ports, but never change origin."""
    origin = https_origin(base_url)
    current = relative_to or base_url.rstrip("/") + "/"
    if https_origin(current) != origin:
        raise HTTPURLPolicyError("market-data URL must retain the configured origin")
    _check_text(reference)
    try:
        parts = urlsplit(reference)
        if parts.scheme and (parts.scheme.lower() != "https" or not parts.netloc):
            raise HTTPURLPolicyError("market-data URL must use an absolute HTTPS origin")
        resolved = urljoin(current, reference)
    except ValueError:
        raise HTTPURLPolicyError("market-data URL is malformed") from None
    if https_origin(resolved) != origin:
        raise HTTPURLPolicyError("market-data URL must retain the configured origin")
    return resolved


class SameOriginRedirectHandler(HTTPRedirectHandler):
    """Reject unsafe Location values before urllib copies credential headers."""

    def __init__(self, base_url: str) -> None:
        https_origin(base_url)
        self.base_url = base_url

    def http_error_302(self, request, response, code, message, headers):
        location = headers.get("location") or headers.get("uri")
        if location is not None:
            try:
                resolve_https_url(self.base_url, location, relative_to=request.full_url)
            except HTTPURLPolicyError:
                # open() has not returned, so the caller's context manager does
                # not yet own this response. Close it on rejected redirects.
                response.close()
                raise
        return super().http_error_302(request, response, code, message, headers)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302

    def redirect_request(self, request, response, code, message, headers, new_url):
        try:
            target = resolve_https_url(self.base_url, new_url, relative_to=request.full_url)
        except HTTPURLPolicyError:
            response.close()
            raise
        return super().redirect_request(request, response, code, message, headers, target)


def build_https_opener(base_url: str):
    return build_opener(SameOriginRedirectHandler(base_url))
