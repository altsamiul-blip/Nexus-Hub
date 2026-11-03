# syntax = docker/dockerfile:1
# NEXUS HUB runtime image.
# Node 22 LTS (jod) on Alpine: current, supported release with a small musl-based
# userland, so the stale Debian glibc/zlib/gnutls packages from the previous
# node:22.5.0-slim base are gone entirely.
FROM node:22.23.4-alpine

# Apply the distro's current fixed packages for this image tag.
RUN apk upgrade --no-cache

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/nexus.db

WORKDIR /app

# No third-party runtime dependencies: the app uses only Node built-ins
# (node:http, node:sqlite, node:crypto), so there is no npm install step.
COPY package.json ./
COPY db.js auth.js server.js ./
COPY public ./public
COPY test ./test

# Persistent data directory. The platform disk is mounted at /data; the app
# falls back to a temp database if that path is unavailable, and logs which
# file it opened.
RUN mkdir -p /data && chmod 0777 /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
