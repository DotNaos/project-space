FROM oven/bun:1 AS deps

WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1 AS runner

WORKDIR /workspace
ARG PROJECT_SPACE_BUILD_COMMIT
LABEL org.opencontainers.image.revision=$PROJECT_SPACE_BUILD_COMMIT
LABEL com.dotnaos.project-space.preview=true
ENV NODE_ENV=production
ENV PROJECT_SPACE_HOST=0.0.0.0
ENV PORT=4173
COPY --from=deps /workspace/node_modules /workspace/node_modules
COPY package.json ./
COPY src ./src
COPY server ./server
CMD ["bun", "server/preview-gateway.ts"]
