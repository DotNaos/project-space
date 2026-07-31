# syntax=docker/dockerfile:1.7

FROM oven/bun:1 AS deps

WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM ghcr.io/pnpm/pnpm:11.10.0 AS mobile-build

WORKDIR /workspace
RUN pnpm runtime set node 24 -g
COPY package.json ./
COPY apps/mobile/package.json apps/mobile/pnpm-lock.yaml ./apps/mobile/
RUN pnpm --dir apps/mobile --ignore-workspace install --frozen-lockfile --ignore-scripts
COPY apps/mobile ./apps/mobile
COPY src ./src
COPY config ./config
COPY apps/docs/content/docs/changelog/entries.json \
  ./apps/docs/content/docs/changelog/entries.json
RUN pnpm --dir apps/mobile run build:prototype

FROM oven/bun:1 AS build

WORKDIR /workspace
ARG PROJECT_SPACE_BUILD_COMMIT
COPY --from=deps /workspace/node_modules /workspace/node_modules
COPY . .
RUN test -n "$PROJECT_SPACE_BUILD_COMMIT" \
  && printf '%s' "$PROJECT_SPACE_BUILD_COMMIT" | grep -Eq '^[0-9a-f]{40}$' \
  && bun run check \
  && bun ./node_modules/vite/bin/vite.js build \
    --config apps/prototype/vite.config.ts \
    --base /prototype/desktop/ \
  && printf '{"commit":"%s","surfaces":["mobile-prototype","desktop-prototype"]}\n' \
    "$PROJECT_SPACE_BUILD_COMMIT" > /workspace/prototype-meta.json
COPY --from=mobile-build /workspace/apps/mobile/dist-prototype /workspace/apps/mobile/dist-prototype

FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0 AS runner

ARG PROJECT_SPACE_BUILD_COMMIT
LABEL org.opencontainers.image.revision=$PROJECT_SPACE_BUILD_COMMIT
LABEL com.dotnaos.project-space.preview=true
COPY --from=trusted-assets deploy/preview.prototype.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/prototype/dist /usr/share/nginx/html/prototype/desktop
COPY --from=build /workspace/apps/mobile/dist-prototype /usr/share/nginx/html/prototype/mobile
COPY --from=build /workspace/prototype-meta.json /usr/share/nginx/html/prototype/meta.json
EXPOSE 8080
