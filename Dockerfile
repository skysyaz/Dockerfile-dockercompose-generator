# ---------- Stage 1: deps (Next.js) ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* yarn.lock* pnpm-lock.yaml* package-lock.json* ./
RUN \
  if [ -f pnpm-lock.yaml ]; then npm i -g pnpm && pnpm install --frozen-lockfile; \
  elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then npm i -g bun && bun install --frozen-lockfile; \
  else npm ci; fi

# ---------- Stage 2: builder ----------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- Stage 3: mini-service deps ----------
FROM node:20-alpine AS mini-deps
WORKDIR /mini
COPY mini-services/docker-build-service/package.json ./
RUN npm install --omit=dev

# ---------- Stage 4: runner ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache docker-cli docker-cli-compose
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

COPY --from=mini-deps /mini/node_modules /mini-services/docker-build-service/node_modules
COPY --chown=nextjs:nodejs mini-services/docker-build-service /mini-services/docker-build-service

COPY --chown=nextjs:nodejs scripts/start.sh /app/start.sh
RUN chmod +x /app/start.sh

USER nextjs
EXPOSE 5172 5173
ENV PORT=5172
ENV BUILD_SERVICE_PORT=5173
ENV NEXT_PUBLIC_BUILD_SERVICE_PORT=5173
ENV HOSTNAME=0.0.0.0
VOLUME ["/var/run/docker.sock"]
CMD ["/app/start.sh"]
