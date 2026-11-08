# Supabase setup (owner runbook)

This runbook sets up the Supabase project for the real-data phase (ADR-020). Web and mobile apps never talk to Supabase. Only our API and worker do, using keys that live in your `.env.local`. Never commit that file, and never paste these keys into a chat with an agent.

Database, storage and run commands (steps 6 to 9) are final (WP-32). Auth names in step 8 are finalized by WP-33.

## 1. Create the project
1. Sign in at supabase.com and create an organization if you don't have one.
2. Click **New project**:
   - **Name:** `moneypilot-dev`.
   - **Region:** a US region, for example *East US (North Virginia)*. Household data stays in the US.
   - **Database password:** generate a long one and save it in your password manager. This is the `postgres` password, used only for the one-time bootstrap.
   - **Plan:** Free is fine for testing. Choose Pro (daily backups) before real household data you'd hate to lose.
3. Wait until the project is ready, then note the **project ref**: the `xxxx` in `https://xxxx.supabase.co`.

## 2. Lock down direct access
Our API is the only way in, so turn off what Supabase exposes by default:
1. **Project Settings → Data API:** turn **off** "Enable Data API". Clients must not reach tables through PostgREST.
2. **Authentication → Sign In / Providers:**
   - **Email:** enabled, with **Confirm email** on.
   - **Allow new users to sign up:** on for now.
3. **Authentication → Multi-Factor:** enable **TOTP (Authenticator app)**.
4. **Project Settings → API Keys:**
   - Copy the **publishable** key and the **secret** key. Both are server-side only and go into `.env.local`, never into web or mobile code.
   - Under **JWT signing keys**, make sure asymmetric signing keys are in use (the current default). The API verifies tokens with the public JWKS at `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`.

## 3. URL settings for local testing
**Authentication → URL Configuration:**
- **Site URL:** `http://localhost:3100`
- **Redirect URLs:** add `http://localhost:4000/v1/auth/google/callback` and `http://localhost:3100/**`.

## 4. Sign in with Google (optional for the first test)
1. In Google Cloud Console, create a project, for example `moneypilot-dev`.
2. Set up the **OAuth consent screen**: External, publishing status **Testing**, and add yourself (and your partner) as **test users**.
3. Create an **OAuth client ID** of type *Web application*:
   - **Authorized redirect URI:** `https://<ref>.supabase.co/auth/v1/callback`
4. In Supabase, open **Authentication → Providers → Google**, enable it, and paste the client ID and secret.

## 5. Gmail connection (email integration, WP-21)
This is separate from Sign in with Google. It's our API reading bills from your inbox, read-only.
1. In the same Google Cloud project, open **APIs & Services → Library** and enable the **Gmail API**.
2. On the consent screen, add the scope `https://www.googleapis.com/auth/gmail.readonly`. It is a restricted scope. Testing mode allows it for your listed test users without Google's review. That review is only needed before real customers.
3. Create a second **OAuth client ID** of type *Web application*:
   - **Authorized redirect URI:** `http://localhost:4000/v1/email-connections/gmail/callback`.
4. Put its client ID and secret in `.env.local` as `GOOGLE_GMAIL_CLIENT_ID` and `GOOGLE_GMAIL_CLIENT_SECRET`.
5. Connecting your own inbox is your G2 decision as owner. Only your listed test users can connect while the app is in Testing mode.
6. Reading bills needs an Anthropic API key (`ANTHROPIC_API_KEY`) for the extraction step (WP-22).

## 6. Storage for bank statements
1. Go to **Storage → New bucket**. **All four settings are required**: they are the last line of defence if an upload bypasses our API, and nothing in our code can set them for you.
   - **Name:** `imports`
   - **Public:** off (**Private**)
   - **File size limit:** exactly **10 MB**
   - **Allowed MIME types:** `text/csv` only

   Verify each one (a minute):
   - *Private:* run `curl -s https://<ref>.storage.supabase.co/storage/v1/object/public/imports/x.csv`. A private bucket answers `{"statusCode":"404","error":"Bucket not found"...}`; anything that returns a file or says the object is missing means the bucket is public.
   - *Size limit and type:* **Storage → Buckets → imports → Edit bucket** shows the size limit and the allowed types; both must read as above. To prove the size limit, upload an 11 MB file of any kind in the dashboard to that bucket: it must be refused. Delete anything you uploaded.
2. Under **Storage → Settings → S3 Connection**, enable the S3 protocol and create an **access key**. Copy the access key ID and secret, and note the endpoint (`https://<ref>.storage.supabase.co/storage/v1/s3`) and the region shown there.
3. Uploads work like this: the web app asks our API for an upload address, and the API answers with a presigned **PUT** URL for the S3 endpoint. The URL signs the file's exact size and `text/csv`, so a different size or type is refused by storage. (Supabase's S3 layer does not offer browser POST policies, which is why it isn't a POST.) The API then re-checks the stored size before the worker reads the file. Nobody but the API and worker holds storage keys.
4. One thing only you can check, because it needs your project (Q-211): upload a CSV through the app (or `pnpm live:smoke` with `.env.local` pointing at Supabase) and confirm it reaches `done`. If storage answers 403 for an upload that matches its signed size, tell the tech lead: the fallback is an upload route on the API.

## 7. Database roles (one-time bootstrap)
1. Open **Connect** (top bar) and copy the **Session pooler** connection string. It works over IPv4, unlike the direct connection, which is IPv6-only unless you buy the add-on. **Always use the session pooler (port 5432).** Not the transaction pooler (port 6543): it hands each statement to any connection, which breaks what we rely on: the migration runner holds a session advisory lock, and pg-boss uses `LISTEN`, advisory locks and session settings. (Our own queries are safe in either mode because every request sets its tenant with `SET LOCAL` inside one transaction, but one wrong pool for pg-boss or migrations is enough to corrupt a run.)
2. Run the bootstrap once, as `postgres`. The URL carries the `postgres.<ref>` user and your database password; add `?sslmode=require`:
   ```bash
   SUPABASE_ADMIN_URL='postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require' \
     pnpm db:bootstrap:supabase
   ```
   It runs `packages/db/supabase/bootstrap.sql`, which:
   - creates `mp_migrator`, `mp_api`, `mp_worker`, `mp_queue` (login, no superuser, **no BYPASSRLS**, cannot create roles or databases) and an unused `mp_analytics` (no login), because the migrations name it;
   - lets `mp_migrator` run `pnpm db:migrate` without owning your database: `CREATE` on schema `public` and on the database (for the `pgboss` schema). It owns the tables it creates;
   - pre-creates the `citext` extension in `public` (where it lives on a normal Postgres, which our functions assume). `pgcrypto` stays in Supabase's `extensions` schema;
   - takes all access to `public` away from `anon`, `authenticated`, `service_role` and PUBLIC. The Data API stays off as well (step 2).

   It then prints four ready-to-paste lines for `.env.local` (`MIGRATOR_DATABASE_URL`, `DATABASE_URL`, `WORKER_DATABASE_URL`, `PGBOSS_DATABASE_URL`) with generated passwords, **once**. It writes nothing to disk and logs no password. The user names get your `.<ref>` suffix automatically (`mp_api.<ref>`), as the pooler requires.
   - Running it again is safe: it re-applies grants and prints nothing secret. `pnpm db:bootstrap:supabase -- --rotate` sets new passwords for all four roles (put the new lines in `.env.local`, then restart the api and worker).
   - Afterwards, delete `SUPABASE_ADMIN_URL` from your shell and `.env.local`. Nothing else needs the `postgres` password.
   - The bootstrap sets the passwords in the session, so they are not in the script. If the project logs statements (`log_statement` set to `all` or `ddl`), the server log can still contain the `alter role … password` text. Keep `log_statement` at its default (`none`) while you bootstrap, and run `--rotate` afterwards if it was on.
3. Apply our migrations as `mp_migrator` (reads `MIGRATOR_DATABASE_URL` from `.env.local`):
   ```bash
   pnpm db:migrate
   ```
   The `pgboss` job-queue schema is created by a migration, so the worker runs pg-boss as `mp_queue`, which cannot change the schema. Don't run `pnpm db:seed` against this project. It loads the sample Rivera household. You'll create your real household through the app.

### TLS
Connections to `*.supabase.com` and `*.supabase.co` are always encrypted **and verified**: our code trusts Supabase's root certificate (`packages/db/certs/supabase-ca.crt`, source and fingerprint in the README beside it) plus Node's public roots, and checks the host name. Put `?sslmode=require` on the URLs as usual; it cannot weaken that. For any other remote database use `?sslmode=verify-full`. In production an unverified remote database stops the API and worker at startup.

Only for debugging a certificate problem, `MP_DB_TLS_INSECURE=1` in `.env.local` encrypts without verifying; the API and worker log a warning, and production refuses to start with it. Remove it when done. The Supabase root certificate expires in April 2031.

## 8. `.env.local`
Copy `.env.example` to `.env.local`, then replace these values. `.env.example` documents the database, storage, mail, web and live-mode keys (WP-32). The auth keys (`SUPABASE_*`) come from WP-33 and the Gmail, token and email keys from WP-21, so they are listed here but may not be in `.env.example` until those work packages merge, and their names are theirs to finalize:
```bash
# Database: the four lines the bootstrap printed (session pooler, TLS)
MIGRATOR_DATABASE_URL=postgresql://mp_migrator.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
DATABASE_URL=postgresql://mp_api.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
WORKER_DATABASE_URL=postgresql://mp_worker.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
PGBOSS_DATABASE_URL=postgresql://mp_queue.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require

# Storage (API and worker only; no client gets these)
S3_ENDPOINT=https://<ref>.storage.supabase.co/storage/v1/s3
S3_REGION=<region from Storage -> S3 Connection>
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET_IMPORTS=imports

# Web (public values only)
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_STORAGE_URL=https://<ref>.storage.supabase.co   # the CSV upload goes here; added to the CSP
WEB_ORIGIN=http://localhost:3100                            # the API's CORS allow-list

# Auth (WP-33 finalizes these names; not in .env.example until it merges)
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SECRET_KEY=...

# Gmail connection and email integration (WP-21), extraction (WP-22); not in .env.example until they merge
GOOGLE_GMAIL_CLIENT_ID=...
GOOGLE_GMAIL_CLIENT_SECRET=...
ANTHROPIC_API_KEY=...
TOKEN_MASTER_KEY=...   # api + worker (local dev only): openssl rand -base64 32. Production uses KMS instead (KMS_TOKEN_KEY_ID)
EMAIL_ADDRESS_HASH_KEY=...   # openssl rand -base64 32 (same value in api and worker)
EMAIL_WEBHOOK_SECRET=...     # openssl rand -base64 32
EMAIL_POLL_MINUTES=15        # Gmail is polled locally (no Pub/Sub push without a public URL)
API_PUBLIC_URL=http://localhost:4000
```
Do not set `NEXT_PUBLIC_MP_MOCK` in `.env.local`: that is the mock-mode switch.

## 9. Run it
```bash
pnpm install
pnpm dev:live      # api :4000, worker, web :3100 against .env.local (not mock mode)
```
`pnpm dev:live` loads `.env.local` once and starts the three processes with prefixed logs; Ctrl+C stops all. Set `API_PORT` and `WEB_PORT` (and `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL` to match) in `.env.local` if 4000 or 3100 is taken. `pnpm dev` stays the mock-mode command.

**Signing in.** Sign-in through Supabase Auth arrives with WP-33. Until it lands, the API refuses every token (it logs `COGNITO_* is not configured`), so the web app cannot sign in in live mode. Until then, check the real path from the command line:
```bash
pnpm live:smoke
```
It starts the API itself (port 4010) with a fake token issuer, against your real database and storage, creates a household named `Smoke <timestamp>`, uploads a **synthetic** CSV (invented merchants), waits for the running worker, and prints the import status and the number of review items. Run `pnpm dev:live` (or at least the worker) first. Use a local or disposable database for this: it leaves that household behind.

Once WP-33 lands, go through the app in this order:
1. Sign up and confirm your email.
2. Create your household.
3. Connect Gmail.
4. Upload a bank CSV.
5. Open the dashboard.

### Trying it all on your machine with no Supabase project
```bash
docker compose up -d postgres minio        # local Postgres (all four roles) and MinIO
cp .env.example .env.local                 # its defaults already point at them
pnpm db:migrate && pnpm storage:init       # schema, then the private `imports` bucket on MinIO
pnpm dev:live
pnpm live:smoke
```
If you started the local Postgres before WP-32, its volume was created without the `mp_queue` role and `db:migrate` stops with `role "mp_queue" does not exist`. Recreate it: `docker compose down -v && docker compose up -d postgres minio` (this deletes the local database). `pnpm dev:live` hands each process only the settings it needs from `.env.local` (the web server gets none of the secrets) and requires `PGBOSS_DATABASE_URL`.

## Troubleshooting
| Symptom | Cause and fix |
|---|---|
| `getaddrinfo ENOTFOUND db.<ref>.supabase.co` or `connect ENETUNREACH` with an IPv6 address | You used the **direct** connection string. It is IPv6-only unless you buy the IPv4 add-on. Use the **Session pooler** string from Connect instead. |
| `password authentication failed for user "postgres"` through the pooler, or `Tenant or user not found` | The pooler needs the role-qualified user: `postgres.<ref>`, `mp_api.<ref>` and so on. The bootstrap output already has it. The region in the host (`aws-0-<region>`) must also be your project's. |
| `self-signed certificate in certificate chain`, `unable to verify the first certificate` or `Hostname/IP does not match certificate's altnames` | The server's certificate does not chain to Supabase's CA or does not match the host. Check the host is exactly the one the dashboard gave you (a `*.supabase.com` or `*.supabase.co` name, not an IP or a proxy), and that nothing on your network intercepts TLS (a corporate proxy: set `NODE_EXTRA_CA_CERTS` to its CA). Do not "fix" it with `MP_DB_TLS_INSECURE=1` outside a short debugging session. |
| `Remote database connections must be verified in production` | `NODE_ENV=production` with a remote database that is not a Supabase host and lacks `sslmode=verify-full`. |
| `SSL connection is required` / `no pg_hba.conf entry … no encryption` | A non-Supabase remote URL without TLS. Supabase hosts always use TLS. |
| `permission denied to create extension "citext"` or `type "citext" does not exist` | The bootstrap has not run (or ran on another project). Run `pnpm db:bootstrap:supabase`, then `pnpm db:migrate`. |
| `role "mp_queue" does not exist` during `db:migrate` | Same: run the bootstrap first. |
| `permission denied to alter role` / `role … exists with SUPERUSER, BYPASSRLS…` from the bootstrap | An `mp_*` role was created by hand with extra rights. Supabase's `postgres` cannot change those attributes. Drop the role in the SQL editor (`drop owned by mp_x; drop role mp_x;`) and run the bootstrap again. |
| `Refusing to migrate as postgres` | `MIGRATOR_DATABASE_URL` must be the `mp_migrator` line, not the admin URL. |
| `Connection role is … this pool only accepts mp_api` | `DATABASE_URL` and `WORKER_DATABASE_URL` are swapped or point at the wrong role. |
| Upload answers 503 `File upload is not available yet` | `S3_ENDPOINT` is not set for the **api** process. |
| Browser: `Refused to connect … Content Security Policy` on upload | Set `NEXT_PUBLIC_STORAGE_URL` to the storage origin and restart the web server. |
| Upload gets 403 `SignatureDoesNotMatch` | The file size differs from what was declared, the clock is off by more than a few minutes, or the region in `S3_REGION` is wrong. |
| An import stays `processing` | The worker is not running, or has no S3 settings (it logs `S3_ENDPOINT is not set`). The worker picks up new imports once a minute. |
| `docker compose up` cannot pull MinIO | The compose file uses `ghcr.io/coollabsio/minio` (Q-210); `minio/minio` is no longer on Docker Hub. |

## Safety notes
- Supabase keeps only 7 days of backups on Pro, and none on Free. Export anything important.
- Rotate the secret key and role passwords if they ever leave `.env.local` (`pnpm db:bootstrap:supabase -- --rotate`).
- Before a shared or deployed environment, replace `TOKEN_MASTER_KEY` with a managed KMS (ADR-020).
