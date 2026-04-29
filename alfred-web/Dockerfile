FROM --platform=$BUILDPLATFORM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
# Use yarn so the lockfile we ship matches what the dev workflow uses.
# `--frozen-lockfile` is added back when the user starts shipping
# yarn.lock; for now we accept the slower fresh install.
RUN npm install --legacy-peer-deps

FROM --platform=$BUILDPLATFORM node:20-alpine AS builder
WORKDIR /app
# NEXT_PUBLIC_* values are inlined into the JS bundle at build time, so
# they have to be present here — not just at runtime. Compose forwards
# them via build args so a `docker compose build` after editing .env
# rebakes them into the image.
ARG NEXT_PUBLIC_API_BASE="http://localhost:8000"
ARG NEXT_PUBLIC_WAKE_KEYWORD="hey_alfred"
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE \
    NEXT_PUBLIC_WAKE_KEYWORD=$NEXT_PUBLIC_WAKE_KEYWORD
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Runtime stage: --platform=$TARGETPLATFORM so the output image
# matches the host that'll actually run it (amd64 desktop or arm64 Pi).
# The `node` runtime is universal so this is just the right architecture
# tag, not a different node version.
FROM --platform=$TARGETPLATFORM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# wget for the healthcheck — busybox-style, no extra packages needed
# in alpine (already installed).
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
