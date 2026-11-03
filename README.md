# NEXUS HUB

**Curated resources. One place.**

A members-only resource directory with real server-side authentication, administrator
approval, and a persistent SQLite database. No email confirmation, no OTP codes, no
magic links — an account works the moment it is created.

## Stack

| Layer | Choice |
| --- | --- |
| Server | Node.js `node:http` (no web framework) |
| Database | SQLite via the built-in `node:sqlite` module (WAL mode) |
| Passwords | `scrypt` via `node:crypto` with a per-user salt |
| Sessions | Opaque 256-bit tokens, SHA-256 hashed at rest, `HttpOnly` cookies |
| Frontend | Vanilla ES modules + CSS (no build step) |
| Dependencies | **None** — only Node built-ins |

Requires **Node 22.13+** (the release where `node:sqlite` no longer needs a flag).

## Run locally

```bash
npm start                       # http://localhost:3000
```

```bash
ADMIN_EMAIL=altsamiul@gmail.com \
ADMIN_PASSWORD='use-a-real-password' \
DB_PATH=./data/nexus.db \
npm start
```

## Routes

| Route | Access |
| --- | --- |
| `/` | Public landing page |
| `/login` | Public |
| `/register` | Public — creates a **pending** account |
| `/directory` | Approved members and administrators only |
| `/admin` | Administrators only (server-enforced) |
| `/account` | Any signed-in account |

## How approval works

1. Anyone can register with a name, email and password.
2. The account is created with `status = pending` and the session is issued
   immediately — there is no verification email anywhere in the flow.
3. A pending account sees an approval-pending screen. `/api/directory` returns
   `403` for it.
4. An administrator approves, suspends, restores or rejects the account.
5. Approval is checked **on every request from the database**, so suspending a
   member invalidates their existing session immediately.

## Administrator provisioning

Administrator rights are **never** granted by comparing an email in the frontend.
The account is created or promoted server-side at boot from environment variables:

```
ADMIN_EMAIL=altsamiul@gmail.com
ADMIN_PASSWORD=<at least 8 characters>
```

On startup the server promotes the existing account for `ADMIN_EMAIL` to
`role = admin, status = approved` (re-applying this if the account already exists),
or creates it with a scrypt password hash when it does not. `ADMIN_PASSWORD` is only
read at boot and is never sent to the browser.

If `ADMIN_EMAIL` is unset the server logs a warning and simply provisions no
administrator; it never falls back to a hard-coded credential.

## API

### Public / session

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness probe |
| `GET` | `/api/categories` | The seven categories |
| `GET` | `/api/public/stats` | Aggregate resource count (no member data) |
| `POST` | `/api/auth/register` | Create account (`pending`) + session |
| `POST` | `/api/auth/login` | Sign in |
| `POST` | `/api/auth/logout` | Destroy session |
| `GET` | `/api/auth/me` | Current user or `null` |

### Member

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/directory?q=&category=` | Approved members only |
| `PATCH` | `/api/account` | Update own name |
| `POST` | `/api/account/password` | Change password |

### Administrator

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/stats` | Member + resource totals, per-category counts |
| `GET` | `/api/admin/members?status=&q=` | List / filter / search members |
| `POST` | `/api/admin/members/:id/status` | `approved` · `suspended` · `pending` · `rejected` |
| `GET` | `/api/admin/resources` | Full resource list |
| `POST` | `/api/admin/resources` | Create resource |
| `PATCH` | `/api/admin/resources/:id` | Update resource |
| `DELETE` | `/api/admin/resources/:id` | Delete resource |

## Security notes

* Every permission decision is made on the server from the session's database row;
  the frontend only mirrors the result.
* Resource URLs must parse as `http`/`https` with a dotted hostname, so
  `javascript:` and `data:` URLs are rejected.
* Passwords are hashed with `scrypt`; comparisons use `timingSafeEqual`.
* Session tokens are stored only as SHA-256 hashes, so a database read cannot
  reconstruct a usable cookie.
* Login is rate-limited per IP + email pair (10 attempts / 10 minutes).
* Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` behind HTTPS.
* No secrets are ever included in the client bundle.
* Escape hatch: administrators cannot be suspended through the member endpoint.

## Tests

```bash
npm test
```

`test/workflow.test.js` boots the real server against a temporary database and
walks the complete workflow: registration with no email confirmation → immediate
sign-in → pending gating → admin approval → directory access → resource
create/edit/delete → suspension and restore → full server restart to prove
persistence.

## Deployment

`Dockerfile` builds on `node:22.23.4-alpine` (current Node 22 LTS). Runtime
environment:

| Variable | Purpose |
| --- | --- |
| `PORT` | Listen port (default `3000`) |
| `HOST` | Bind address (default `0.0.0.0` when `PORT` is set) |
| `DB_PATH` | SQLite file, e.g. `/data/nexus.db` on a mounted disk |
| `ADMIN_EMAIL` | Administrator email to provision at boot |
| `ADMIN_PASSWORD` | Initial administrator password |

Mount a persistent volume at `/data` so the database survives redeploys. If
`DB_PATH` is unwritable the server falls back to a temporary directory and logs
the path it actually opened.
