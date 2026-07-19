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
RUN mkdir -p public
RUN npm run build

# ---------- Stage 3: mini-service deps ----------
FROM node:20-alpine AS mini-deps
WORKDIR /mini
COPY mini-services/docker-build-service/package.json ./docker-build-service/
RUN cd docker-build-service && npm install --omit=dev
COPY mini-services/port-proxy/package.json ./port-proxy/
RUN cd port-proxy && npm install --omit=dev

# ---------- Stage 4: runner ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ARG DOCKER_GID=999
RUN apk add --no-cache docker-cli docker-cli-compose su-exec && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001 -G nodejs -h /home/nextjs && \
    mkdir -p /home/nextjs/.docker && \
    chown -R nextjs:nodejs /home/nextjs && \
    if getent group "${DOCKER_GID}" >/dev/null 2>&1; then \
      adduser nextjs "$(getent group "${DOCKER_GID}" | cut -d: -f1)"; \
    else \
      addgroup -g "${DOCKER_GID}" -S docker && adduser nextjs docker; \
    fi

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

COPY --from=mini-deps /mini/docker-build-service/node_modules /mini-services/docker-build-service/node_modules
COPY --chown=nextjs:nodejs mini-services/docker-build-service /mini-services/docker-build-service
COPY --from=mini-deps /mini/port-proxy/node_modules /mini-services/port-proxy/node_modules
COPY mini-services/port-proxy/index.mjs /mini-services/port-proxy/index.mjs

COPY --chown=root:root scripts/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 5172 5173
ENV PORT=5172
ENV NEXT_INTERNAL_PORT=5174
ENV BUILD_SERVICE_PORT=5173
ENV BUILD_SERVICE_TOKEN=
ENV BUILD_SERVICE_ORIGINS=
ENV HOSTNAME=0.0.0.0
ENV HOME=/home/nextjs
ENV DOCKER_CONFIG=/home/nextjs/.docker
VOLUME ["/var/run/docker.sock"]
CMD ["/app/start.sh"]
