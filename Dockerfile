# Lightweight control-plane image — it dispatches builds to GitHub Actions and
# serves the resulting installers. No Rust/Tauri toolchain here, so it stays small.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

ENV PORT=3000 \
    BUILD_DIR=/data/builds \
    MAX_ACTIVE=8
RUN mkdir -p /data/builds
EXPOSE 3000

# tsx runs the TypeScript entrypoint directly (no separate compile step).
CMD ["npm", "start"]
