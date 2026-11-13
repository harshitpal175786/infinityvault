# Mobile Phase 1 — Reachability and Auth

Status: **complete, verified from the LAN address.**

## What changed

### 1. Access token generated

There was none. `/api/auth/status` reported `configured: false`, and the API
allowed every request through while advertising itself as `unsecured` in a
response header. A phone on the same Wi-Fi could have read the whole library.

Generated with `npm run infinityvault -- token`, stored in the private env file
at mode 0600.

### 2. Host binding made configurable, with a guard

`scripts/infinityvault.mjs` hardcoded `--host 127.0.0.1`, which a phone cannot
reach. It now reads `INFINITYVAULT_HOST` and defaults to loopback.

The important part is the coupling: **binding to the network is refused unless a
token exists.** Those two decisions belong together, and leaving it to the caller
to remember would eventually expose someone's library on a café Wi-Fi. Verified
by trying it:

```
Refusing to listen on 0.0.0.0 without an access token.
That would expose your whole library to every device on this network.
```

## Exit criteria — all verified from `192.168.1.34`

| # | Check | Result |
|---|---|---|
| 1 | `/api/health` public | **200** |
| 2 | `/api/media` with no token | **401** |
| 3 | `/api/media` with a bad token | **401** |
| 4 | `/api/media` with bearer header | **200** |
| 5 | `/api/media` with `?access_token=` | **200** |
| 6 | thumbnail with `?access_token=` | **200** |
| 7 | thumbnail with no token | **401** |

Every endpoint the app needs answers from the LAN: media, albums, people, tags,
memories, backup status, health.

Keyset pagination confirmed end to end — three pages of 100, cursor advancing,
300 items total.

## Two findings worth carrying forward

### Auth accepts the token as a query parameter

`auth.extract_token()` falls back to `?access_token=`. This was written for
`<img>` tags that cannot set headers, and it is exactly what React Native's
`<Image source={{uri}}>` needs. **No backend change required for mobile images.**

### The DB column and the wire field have different names

- SQLite column: `capture_time`
- JSON field: `captured_at`

An earlier draft of the PRD said `capture_time` was the wire name. That was
wrong and has been corrected. Mobile reads `captured_at` from JSON.

## Transport decision

**Tailscale is not installed on this machine, so this is currently LAN-only.**

That works, and it is what was verified above, but it has a real limitation: the
vault is readable by any device on the same network that has the token, and is
unreachable outside the house.

Recommended next step whenever it is convenient: install Tailscale, then the
phone reaches the vault from anywhere over an authenticated mesh, and
`INFINITYVAULT_HOST` points at the tailnet interface. No code change — only the
host value.

## Not done

- No mobile code yet. Phase 2 starts the Expo project.
- No TLS. On a trusted LAN with a token this is defensible; over anything else
  the token travels in plaintext.
