# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:24-slim AS builder

WORKDIR /workspace

# Install pnpm
RUN npm install -g pnpm@latest

# Copy workspace-level package files first (for layer caching)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.json tsconfig.base.json ./

# Copy all lib packages (api-server depends on them)
COPY lib/ ./lib/

# Copy the api-server artifact
COPY artifacts/api-server/ ./artifacts/api-server/

# Install all dependencies (workspace aware)
RUN pnpm install --frozen-lockfile

# Build shared libs first, then the api-server
RUN pnpm run typecheck:libs
RUN pnpm --filter @workspace/api-server run build

# ─── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM node:24-slim AS runner

WORKDIR /app

# Copy the bundled output — esbuild produces a self-contained dist/
COPY --from=builder /workspace/artifacts/api-server/dist ./dist

# Expose the HTTP port
EXPOSE 8080

# On a plain VPS there's no /api reverse-proxy prefix — serve at root
ENV PORT=8080
ENV BASE_PATH=""
ENV NODE_ENV=production

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
