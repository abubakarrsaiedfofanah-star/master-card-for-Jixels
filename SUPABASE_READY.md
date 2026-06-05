# Supabase Ready Notes

This app currently runs with local JSON files:

- `cards-db.json`
- `audit-log.json`
- `admin-config.json`

It is prepared for Supabase by keeping all data access behind `server.js` API routes. To move to Supabase later, keep the browser pages the same and replace the storage functions in `server.js`:

- `loadCards()`
- `saveCards(cards)`
- `appendAudit(action, card, actor)`

Use `supabase-schema.sql` in the Supabase SQL editor to create the tables.

Recommended environment variables for a Supabase deployment:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ADMIN_USER=admin
ADMIN_PASS=change-this-password
PORT=8080
```

Security note: keep `SUPABASE_SERVICE_ROLE_KEY` only on the server. Do not put it in `index.html` or `admin.html`.
