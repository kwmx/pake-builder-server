# Control plane only — it dispatches builds to GitHub Actions and serves what
# they produce, so no Rust/Tauri toolchain is needed and the image stays small.
#
# Node 22 is required: job history uses the built-in node:sqlite module
# (available from 22.5, and without a flag from 22.22 onward).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# DATA_DIR holds both the SQLite job history and the mirrored installers, so a
# single volume mounted at /data preserves everything across redeploys.
ENV PORT=3000 \
    DATA_DIR=/data \
    MAX_ACTIVE=4 \
    RETENTION_DAYS=7
RUN mkdir -p /data/builds
EXPOSE 3000

# tsx runs the TypeScript entrypoint directly (no separate compile step).
CMD ["npm", "start"]
