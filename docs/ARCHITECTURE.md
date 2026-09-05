# SnappyDo — Architecture (v0.1)

## Overview

SnappyDo is a single Docker image containing everything needed to run the app.
Move it between Horizon, a VPS, Cloud Run, or any Docker host — same image, same behavior.

## Components

### SnappyDo container (this repo)
- **Runtime**: Node 20 (bookworm-slim base, non-root user, dumb-init PID 1)
- **Framework**: Astro 4 + Node adapter (SSR mode, `output: 'server'`)
- **Listens**: `0.0.0.0:3000`
- **Healthcheck**: `GET /api/health` → 200 OK
- **Image size target**: < 250 MB (Node + prod deps + dist only)

### External services (configured via env)

| Service | Where | Purpose |
|---|---|---|
| **imgproxy** | Horizon (`192.168.0.2:8080`) | Image transformation (AVIF/WebP, resize, srcset) |
| **Supabase Postgres** | supabase.com (cloud) or self-host compose | Users, galleries, orders, EXIF metadata |
| **Cloudflare R2** | Cloudflare | S3-compatible object store for originals |
| **Stripe** | stripe.com | Payments (prints, digital downloads, subs) |

### Out of scope for v0.1
- Visual page builder — Wave 3
- Client galleries (password + favourites) — Wave 2
- Stripe checkout — Wave 2
- Blog — Wave 3

## Docker layout

Multi-stage build (3 stages):
1. **deps** — installs npm packages
2. **build** — runs `astro build` with public env baked in
3. **runtime** — minimal image, dist + node_modules only, non-root user

Build context excludes via `.dockerignore`:
- `node_modules`, `.astro`, `dist`, `.env`, `.git`, `uploads`, docs

## Image portability

The image runs unchanged on:
- Horizon (Ubuntu, Docker) — primary deployment
- Any Linux VPS with Docker
- macOS Docker Desktop (dev)
- Fly.io, Render, Cloud Run (lift to k8s or fly.toml later)

## Environment variables

Public (browser-visible): `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`

Server-only:
- `SUPABASE_SERVICE_ROLE_KEY`
- `IMGPROXY_URL`, `IMGPROXY_KEY`, `IMGPROXY_SALT`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- `SESSION_SECRET`

Build-time only:
- `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` (baked into client bundle)

See `.env.example` for the full list with defaults.

## First-run checklist (Horizon)

```bash
cd ~/snappydo   # or wherever the project lives
cp .env.example .env
# fill in real secrets
docker compose pull
docker compose build
docker compose up -d
docker compose logs -f snappydo
curl http://localhost:3000/api/health
```

## Next milestones

1. **v0.1** — Container builds + serves landing page + healthy. ✅ DONE 2026-09-05
2. **v0.2** — Image upload → R2 → imgproxy → AVIF renders on a gallery page
3. **v0.3** — Supabase auth + gallery CRUD
4. **v0.4** — Stripe integration (test mode)
5. **v0.5** — Visual page builder MVP
