"""Access control for a single-owner private vault.

Threat model: one person owns this library. There are no accounts, no
registration, and no roles. The only question is "is this request from the
owner?" — not "which user is this?", which is what OAuth would answer.

So the primitive is a bearer token: one long random secret, generated once,
stored in the private env file at mode 0600. That matches how Immich worked
before it grew multi-user, and it avoids an external dependency that can break
login for a locally hosted app.

Deliberately NOT used:
* **Google OAuth** — would identify a Google account, but the library is not
  "who are you", it is "are you the vault owner". Also needs a registered
  client secret and a public redirect URI, which a local-only app lacks.
* **Telegram login** — the Telegram session already authenticates us to the
  *storage backend*. Using Telegram to also authenticate the web app would mean
  anyone who can log into the Telegram account gets the photo library, and it
  needs a public domain for the login widget.

If multi-user is ever wanted, this module is the single place to replace.
"""

from __future__ import annotations

import hmac
import logging
import os
import secrets
from pathlib import Path

logger = logging.getLogger(__name__)

TOKEN_ENV_NAME = "INFINITYVAULT_ACCESS_TOKEN"

# Paths that must stay reachable without a token, otherwise the UI cannot
# discover that it needs one, and health checks break.
PUBLIC_PATHS = {
    "/api/health",
    "/health",
    "/api/auth/status",
}

# Development-only origins. A token is required in every mode; this only
# decides whether CORS is permissive.
_MIN_TOKEN_LENGTH = 24


class AuthConfig:
    def __init__(self, token: str | None = None, *, required: bool = True) -> None:
        self._token = token
        self.required = required

    @property
    def token(self) -> str | None:
        return self._token

    @property
    def configured(self) -> bool:
        return bool(self._token)


def load_token(env_file: Path | None = None) -> str | None:
    """Read the access token from the environment, falling back to the env file.

    The env file is used because the launcher may start the backend without
    exporting the variable, and users edit that file directly.
    """
    value = os.getenv(TOKEN_ENV_NAME, "").strip()
    if value:
        return value

    if env_file and env_file.is_file():
        try:
            for line in env_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, raw = line.partition("=")
                if key.strip() == TOKEN_ENV_NAME:
                    return raw.strip().strip("'\"") or None
        except OSError:
            logger.warning("Could not read the access token from %s", env_file)
    return None


def generate_token() -> str:
    """A URL-safe 256-bit secret. Long enough that guessing is not a concern."""
    return secrets.token_urlsafe(32)


def token_is_valid(provided: str | None, expected: str | None) -> bool:
    """Constant-time comparison so response timing cannot leak the token."""
    if not expected or not provided:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


def extract_token(headers: dict, query_token: str | None = None) -> str | None:
    """Accept a bearer header, falling back to a query parameter.

    The query fallback exists because `<img>`, `<video>` and download anchors
    cannot set custom headers. Thumbnails already depend on `?client_id=` for
    the same reason.
    """
    authorization = headers.get("authorization") or headers.get("Authorization")
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value.strip():
            return value.strip()
    if query_token:
        return query_token.strip()
    return None


def validate_configuration(token: str | None) -> str | None:
    """Return a human-readable problem with the configured token, if any."""
    if not token:
        return (
            "No access token is configured. Set "
            f"{TOKEN_ENV_NAME} in your InfinityVault env file."
        )
    if len(token) < _MIN_TOKEN_LENGTH:
        return (
            f"The access token is shorter than {_MIN_TOKEN_LENGTH} characters. "
            "Generate a new one with: npm run infinityvault -- token"
        )
    return None
