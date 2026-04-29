# Alfred test credentials

## Local single-user password gate (Feb 2026)

Auth is **opt-in** — disabled by default for backwards compatibility
with Tailscale-only deployments. To enable:

1. Generate a bcrypt hash of your master password on the host:
   ```bash
   python -c "import bcrypt; print(bcrypt.hashpw(b'YOUR_PASSWORD_HERE', bcrypt.gensalt()).decode())"
   ```
2. Generate a JWT secret:
   ```bash
   python -c "import secrets; print(secrets.token_hex(32))"
   ```
3. Drop both into `.env` (no quotes, no spaces around `=`):
   ```
   ALFRED_PASSWORD_HASH=$2b$12$....   # the bcrypt output
   ALFRED_JWT_SECRET=...               # the 64-char hex
   ALFRED_FRONTEND_ORIGIN=http://alfred.local:3000
   ```
4. Run `./scripts/alfred-update.sh` to rebuild + restart.

After that, the HUD redirects to a JARVIS-styled login page. Enter
your password to engage. The session lasts 60 minutes by default,
auto-refreshing for 30 days via the refresh-token cookie (so you
realistically log in once a month).

## Test password (DEV ONLY — never use this in production)

For local dev / testing only:

- **password**: `alfred-rules-2026`
- **bcrypt hash** (paste this as `ALFRED_PASSWORD_HASH` if you want
  the test password to work without generating your own):

  Run this once to generate yours:
  ```bash
  python -c "import bcrypt; print(bcrypt.hashpw(b'alfred-rules-2026', bcrypt.gensalt()).decode())"
  ```

## Auth endpoints

- `POST /api/auth/login`     — body `{password: str}` → sets cookies
- `GET  /api/auth/me`        — `{authed, user, auth_enabled}`
- `POST /api/auth/logout`    — clears cookies
- `POST /api/auth/refresh`   — mints fresh access cookie from refresh
- `POST /api/auth/change`    — body `{old_password, new_password}` →
                               returns the new bcrypt hash for `.env`
                               (NOT auto-applied; you paste + restart)

## Brute-force protection

5 failed login attempts from one IP = 15-minute lockout. Counter is
in-memory so a backend restart clears it.
