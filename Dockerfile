# syntax=docker/dockerfile:1
#
# One image, one process, one port: the Node server serves both the API and the built web app.
# Keys are read from the RUNTIME environment only (QLOO_API_KEY, NEBIUS_API_KEY); nothing secret is baked in.
#
#   docker build -t shelfwise .
#   docker run --rm -p 8790:8790 -e QLOO_API_KEY=... -e NEBIUS_API_KEY=... shelfwise
#   docker run --rm -p 8790:8790 -e DEMO_FIXTURES=1 shelfwise        # sample-data mode, no keys

# ---- build: compile the web app and the server (dev dependencies live only in this stage)
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build

# ---- deps: production dependencies only (includes the Qloo harness that provides `qloo mcp`)
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8790
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts/check-llm.mjs ./scripts/check-llm.mjs
USER node
EXPOSE 8790
# /healthz reports the mode (live or sample-data) and whether the long-lived `qloo mcp` child is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
