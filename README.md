# SnappyDo

**Tagline**: A website builder for photographers that looks like Framer and runs the photo business like SmugMug.

**Domain**: SnappyDo.net (verify availability before public launch)
**Stack**: Astro/Next + imgproxy (Horizon) + Supabase + Stripe + Cloudflare R2
**Canonical KB**: `~/.openclaw/omi.sh search "SnappyDo"` → [[SnappyDo project initiation]]

## Status
- 2026-09-05: Project initiated. Research complete. Wave 1 in progress.

## Folder Layout
- `docs/` — Specs, design notes, research artifacts
- `prototype/` — MVP code (Astro prototype first)
- `scripts/` — Deployment + ops scripts (imgproxy setup, Horizon deploy)

## Key Decisions
- imgproxy self-hosted on Horizon (Daz's 192.168.0.2)
- Supabase for DB + auth + storage
- Astro preferred for static-first speed; revisit if builder canvas demands Next.js
- Stripe for payments
- Cloudflare Pages for static hosting, R2 for object storage

## See Also
- `~/.openclaw/omi.sh get "SnappyDo project initiation"` (canonical)
- `~/.openclaw/omi.sh get "Horizon — home lab server overview"` (for imgproxy deployment context)
