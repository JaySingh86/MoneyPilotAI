# Supabase setup (owner runbook)

This runbook sets up the Supabase project for the real-data phase (ADR-020). Web and mobile apps never talk to Supabase. Only our API and worker do, using keys that live in your `.env.local`. Never commit that file, and never paste these keys into a chat with an agent.

Steps marked **(WP-32)** or **(WP-33)** gain their exact commands when those work packages land.

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
- **Redirect URLs:** add `http://localhost:4000/auth/callback` and `http://localhost:3100/**`.

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
1. Go to **Storage → New bucket**:
   - **Name:** `imports`
   - **Public:** off (private)
   - **File size limit:** 10 MB
   - **Allowed MIME types:** `text/csv`
2. Under **Storage → Settings → S3 Connection**, enable the S3 protocol and create an **access key**. Copy the access key ID and secret, and note the endpoint (`https://<ref>.storage.supabase.co/storage/v1/s3`) and the region shown there.

## 7. Database roles (one-time bootstrap) (WP-32)
1. Open **Connect** (top bar) and copy the **Session pooler** connection string. It works over IPv4, unlike the direct connection, which is IPv6-only unless you buy the add-on. Session mode is required for our migrations and the job queue.
2. Run the bootstrap once, as `postgres`. It creates our own roles (`mp_migrator`, `mp_api`, `mp_worker`, `mp_queue`). None has BYPASSRLS, so row-level security still protects every household.
   ```bash
   # (WP-32 fills in the exact command)
   SUPABASE_ADMIN_URL='postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
     pnpm db:bootstrap:supabase
   ```
   The script prints a generated password for each role. Put them in `.env.local`. Through the pooler, user names are role-qualified, for example `mp_api.<ref>`.
3. Apply our migrations as `mp_migrator`:
   ```bash
   pnpm db:migrate   # uses MIGRATOR_DATABASE_URL from .env.local
   ```
   Don't run `pnpm db:seed` against this project. It loads the sample Rivera household. You'll create your real household through the app.

## 8. `.env.local` (WP-32 and WP-33 finalize the names)
```bash
# Database (session pooler, TLS)
MIGRATOR_DATABASE_URL=postgresql://mp_migrator.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
DATABASE_URL=postgresql://mp_api.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
WORKER_DATABASE_URL=postgresql://mp_worker.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
PGBOSS_DATABASE_URL=postgresql://mp_queue.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require

# Auth (API only)
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SECRET_KEY=...

# Storage (API and worker only)
S3_ENDPOINT=https://<ref>.storage.supabase.co/storage/v1/s3
S3_REGION=<region>
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BUCKET_IMPORTS=imports

# Gmail connection and extraction
GOOGLE_GMAIL_CLIENT_ID=...
GOOGLE_GMAIL_CLIENT_SECRET=...
ANTHROPIC_API_KEY=...
TOKEN_MASTER_KEY=...   # api + worker (local dev only): openssl rand -base64 32. Production uses KMS instead (KMS_TOKEN_KEY_ID)
EMAIL_ADDRESS_HASH_KEY=...   # openssl rand -base64 32 (same value in api and worker)
EMAIL_WEBHOOK_SECRET=...     # openssl rand -base64 32
EMAIL_POLL_MINUTES=15        # Gmail is polled locally (no Pub/Sub push without a public URL)
API_PUBLIC_URL=http://localhost:4000

# Web
NEXT_PUBLIC_API_URL=http://localhost:4000
```

## 9. Run it (WP-32)
```bash
pnpm install
pnpm dev:live      # api :4000, worker, web :3100 against .env.local (not mock mode)
```
Then go through the app in this order:
1. Sign up and confirm your email.
2. Create your household.
3. Connect Gmail.
4. Upload a bank CSV.
5. Open the dashboard.

## Safety notes
- Supabase keeps only 7 days of backups on Pro, and none on Free. Export anything important.
- Rotate the secret key and role passwords if they ever leave `.env.local`.
- Before a shared or deployed environment, replace `TOKEN_MASTER_KEY` with a managed KMS (ADR-020).
