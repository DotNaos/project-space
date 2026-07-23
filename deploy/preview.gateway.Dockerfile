FROM oven/bun:1 AS deps

WORKDIR /workspace
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1 AS runner

WORKDIR /workspace
ARG PROJECT_SPACE_BUILD_COMMIT
LABEL org.opencontainers.image.revision=$PROJECT_SPACE_BUILD_COMMIT
ENV NODE_ENV=production
ENV PROJECT_SPACE_HOST=0.0.0.0
ENV PORT=4173
COPY --from=deps /workspace/node_modules /workspace/node_modules
COPY package.json ./
COPY server ./server
CMD ["bun", "server/preview-gateway.ts"]
