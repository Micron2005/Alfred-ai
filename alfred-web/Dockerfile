FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --legacy-peer-deps

FROM node:20-alpine AS builder
WORKDIR /app
# NEXT_PUBLIC_* values are inlined into the JS bundle at build time, so
# they have to be present here — not just at runtime. Compose forwards
# them via build args so a `docker compose build` after editing .env
# rebakes them into the image.
ARG NEXT_PUBLIC_API_BASE="http://localhost:8000"
ARG NEXT_PUBLIC_WAKE_KEYWORD="hey_jarvis"
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE \
    NEXT_PUBLIC_WAKE_KEYWORD=$NEXT_PUBLIC_WAKE_KEYWORD
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
