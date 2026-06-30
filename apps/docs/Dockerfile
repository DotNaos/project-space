FROM oven/bun:1 AS deps

WORKDIR /workspace/apps/docs
COPY apps/docs/package.json apps/docs/bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS build

WORKDIR /workspace
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /workspace/apps/docs/node_modules /workspace/apps/docs/node_modules
COPY apps/docs /workspace/apps/docs
WORKDIR /workspace/apps/docs
RUN bun run build

FROM oven/bun:1 AS runner

WORKDIR /workspace
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=build /workspace/apps/docs /workspace/apps/docs
WORKDIR /workspace/apps/docs

EXPOSE 3000
CMD ["bun", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]
