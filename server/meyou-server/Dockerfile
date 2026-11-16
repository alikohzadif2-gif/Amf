# meYou server image: Node 22 (LTS) slim. ffmpeg and sharp come from npm (static binaries inside
# node_modules), so the image needs NO apt and nothing but the npm registry.
# Build context = this folder (server/meyou-server).
#
# Build arguments (docker-compose passes them from .env):
#   NODE_IMAGE      base image; use a mirror when Docker Hub is blocked,
#                   e.g. public.ecr.aws/docker/library/node:22-slim
#   NPM_REGISTRY    npm registry used by `npm ci`
#   INSTALL_FFMPEG  legacy, not needed any more (ffmpeg is the npm package @ffmpeg-installer/ffmpeg).
#                   "true" would add the Debian ffmpeg through apt; keep it false on restricted networks.
ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
# Slow or unreliable networks: few parallel connections, long timeouts, retries.
ARG NPM_FLAGS="--maxsockets=4 --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-timeout=300000"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry="${NPM_REGISTRY}" ${NPM_FLAGS}
COPY tsconfig.json ./
COPY src ./src
# Keep only production modules (sharp + the ffmpeg binary are big): the runtime stage copies
# them, so the slow npm download happens ONCE per build instead of twice.
RUN npm run build && npm prune --omit=dev --registry="${NPM_REGISTRY}" ${NPM_FLAGS}

FROM ${NODE_IMAGE}
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG NPM_FLAGS="--maxsockets=4 --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-timeout=300000"
ARG INSTALL_FFMPEG=false
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    NODE_NO_WARNINGS=1
RUN if [ "${INSTALL_FFMPEG}" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# `docker compose exec meyou-server meyou-server init`
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/meyou-server \
 && chmod +x /usr/local/bin/meyou-server \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
# S11: the public /ping must answer 200 (it is also what `docker compose ps` shows as "healthy").
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/ping',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["meyou-server", "serve"]
