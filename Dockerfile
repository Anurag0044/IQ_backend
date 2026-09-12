# ============================================================
# CloudIQ Backend — Dockerfile for GCP Cloud Run
# Multi-stage build: builder (installs deps) → runtime (lean)
# ============================================================

# ── Stage 1: builder ────────────────────────────────────────
FROM node:22-alpine AS builder

# Install only what's needed to compile native addons
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy manifests first — Docker layer cache skips npm install
# when only source files change
COPY package.json package-lock.json ./

# Install ALL deps (including dev) so we can prune next
RUN npm ci --prefer-offline

# ── Stage 2: runtime ────────────────────────────────────────
FROM node:22-alpine AS runtime

# Security: run as non-root user
RUN addgroup -S cloudiq && adduser -S -G cloudiq cloudiq

WORKDIR /app

# Copy only production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY --chown=cloudiq:cloudiq . .

# Remove dev/test files that should not ship
RUN rm -f test_cloudant.js test_create.js

# Cloud Run injects PORT env; 8080 is the default
ENV PORT=8080
ENV NODE_ENV=production

# Expose for local docker run testing
EXPOSE 8080

USER cloudiq

# Graceful startup — Node directly (no shell wrapping)
CMD ["node", "server.js"]
