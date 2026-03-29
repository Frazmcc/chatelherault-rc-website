# Cloudflare Setup

This project is a static site on Cloudflare Pages with auth handled by Pages Functions + D1.

## 1. Create D1 database

```bash
npx wrangler d1 create chatelherault_auth
```

Copy the returned `database_id` into `wrangler.toml`.

## 2. Apply schema

```bash
npx wrangler d1 execute chatelherault_auth --file=./migrations/0001_create_users.sql --remote
```

## 3. Add secrets in Cloudflare

Set these in your Pages project settings:

- `AUTH_PEPPER`
- `AUTH_SESSION_SECRET`
- Optional: `SESSION_TTL_SECONDS` (defaults to 43200)

Use different long random values for pepper and session secret.

## 4. Seed users into D1

Generate SQL for a user:

```bash
AUTH_PEPPER="your_pepper_here" node scripts/cloudflare-user-sql.js --username Frazer --role owner --password "YourStrongPassword!123"
```

Run the generated SQL against D1:

```bash
npx wrangler d1 execute chatelherault_auth --command "<PASTE_GENERATED_SQL>" --remote
```

Repeat for any additional users.

## 5. Deploy

Push to `main`. Cloudflare Pages will deploy automatically.

## Routes and protection

- `POST /api/login` sets secure session cookie.
- `POST /api/logout` clears session cookie.
- `/admin/login.html` and `/admin/root-login.html` remain public.
- All other `/admin/*` routes require a valid session.
- Owner-only routes:
  - `/admin/root-owner.html`
  - `/admin/godmode.html`
  - `/admin/root-management.html`
