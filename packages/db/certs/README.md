# Supabase root CA

`supabase-ca.crt` is **Supabase Root 2021 CA** (valid 2021-04-28 to 2031-04-26), the public root certificate
Supabase publishes for verifying its database servers. `src/connection.ts` trusts it, together with Node's
built-in public roots, for every host ending `.supabase.com` or `.supabase.co`, and verifies the hostname.

- Source: `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`, also on the
  dashboard under **Project Settings → Database → SSL Configuration**.
- SHA-256 fingerprint: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.
  `connection.test.ts` pins it, so an edited file fails the tests.
- A public certificate, not a secret. Replace it (and the fingerprint in the test) before April 2031, or earlier if
  Supabase rotates its CA; the dashboard announces that.
