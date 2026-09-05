# ---------- Stage 1: deps ----------
# Install dependencies in a clean layer for caching
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Install OS deps needed for sharp/Astro image optimization
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---------- Stage 2: build ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time public env (override at build with --build-arg)
ARG PUBLIC_SUPABASE_URL
ARG PUBLIC_SUPABASE_ANON_KEY
ENV PUBLIC_SUPABASE_URL=${PUBLIC_SUPABASE_URL}
ENV PUBLIC_SUPABASE_ANON_KEY=${PUBLIC_SUPABASE_ANON_KEY}

RUN npm run build

# ---------- Stage 3: runtime ----------
# Minimal runtime image — Node only, no build tools
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

# Runtime libs only (no compilers)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips42 \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for security
RUN groupadd --system --gid 1001 snappydo && \
    useradd --system --uid 1001 --gid snappydo --home /app snappydo

COPY --from=build --chown=snappydo:snappydo /app/dist ./dist
COPY --from=build --chown=snappydo:snappydo /app/node_modules ./node_modules
COPY --from=build --chown=snappydo:snappydo /app/package.json ./package.json

USER snappydo

EXPOSE 3000

# dumb-init handles PID 1 + signal forwarding properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "./dist/server/entry.mjs"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
