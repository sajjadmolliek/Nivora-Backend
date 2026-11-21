# Nivora-Backend

NIVORA backend — Express + Mongoose API and the React admin dashboard.

```
src/server.ts        the whole API (models, routes, auth, orders, settings)
admin/               staff dashboard (Vite + React, built to /admin)
api/[...path].ts     Vercel serverless entry
scripts/             build helpers
```

## Local development

```bash
npm install
cp .env.example .env     # fill in MONGODB_URI + JWT_SECRET
npm run dev              # API on http://localhost:4000
npm run build -w @bongo/dashboard   # or: npm --prefix admin run build
```

With a dashboard build present the API serves it at `/admin`.

## Deployment

Deployed on Vercel as project `nivora-backend` → https://nivora-backend.vercel.app

- API: `https://nivora-backend.vercel.app/api/*` (serverless function `api/[...path].ts`)
- Dashboard: `https://nivora-backend.vercel.app/admin/` (static build in `public/admin`)

Required environment variables (Vercel → Project → Settings → Environment Variables):

| Variable | Example |
| --- | --- |
| `MONGODB_URI` | Atlas connection string |
| `JWT_SECRET` | 64+ random characters |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first admin account |
| `APP_ORIGIN` | `https://nivora.vercel.app` |
| `COOKIE_SAMESITE` | `lax` |
| `TRUST_PROXY` | `1` |

MongoDB Atlas must allow connections from Vercel: add `0.0.0.0/0` in
**Atlas → Network Access** (serverless IPs are not fixed).
