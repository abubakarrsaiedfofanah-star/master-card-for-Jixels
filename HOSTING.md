# Hosting Checklist

This app can run on any Node.js host that supports a long-running server.

## Required Environment Variables

```env
PORT=8081
PUBLIC_BASE_URL=https://your-hosted-domain.com
ADMIN_USER=admin
ADMIN_PASS=X4OotFyn0xRVD3nkq9IVIH4bvMceSJ8f
ADMIN_EMAIL=admin@example.com
MASTER_TOKEN=e505cd63ee68a61a4d80c8f7ea6044fc00592439699f264e
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
RESEND_API_KEY=re_your_key
RESET_FROM_EMAIL=MAPPHEX ID Cards <onboarding@resend.dev>
```

## Supabase Setup

1. Create a Supabase project.
2. Open the Supabase SQL editor.
3. Run `supabase-schema.sql`.
4. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to your hosting environment.

Keep the service-role key only on the server. Do not paste it into `index.html` or `admin.html`.

`RESEND_API_KEY` and `RESET_FROM_EMAIL` are needed for the Forgot Password email code flow. Without them, login still works, but email reset cannot send a code.

If Supabase gives an error about `inactive_reason`, run this in the SQL editor:

```sql
alter table cards add column if not exists inactive_reason text;
```

## QR Printing

Print the master QR only after `PUBLIC_BASE_URL` is your final hosted URL and `MASTER_TOKEN` is set.

The master link will be:

```text
https://your-hosted-domain.com/?master=YOUR_MASTER_TOKEN#apply
```

Use `/api/master-link` on the hosted site to get the exact final QR link.
