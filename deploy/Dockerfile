FROM oven/bun:1 AS deps

WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS build

WORKDIR /workspace
ARG VITE_CLERK_PUBLISHABLE_KEY=
ENV VITE_PROJECT_SPACE_API_BASE_URL=
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
COPY --from=deps /workspace/node_modules /workspace/node_modules
COPY . .
RUN bun run build

FROM oven/bun:1 AS runner

WORKDIR /workspace
ENV NODE_ENV=production
ENV PROJECT_SPACE_HOST=0.0.0.0
ENV PROJECT_SPACE_PORT=4173

COPY --from=build /workspace/bin /workspace/bin
COPY --from=build /workspace/dist/renderer /workspace/dist/renderer
COPY --from=build /workspace/package.json /workspace/package.json
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build /workspace/server /workspace/server
COPY --from=build /workspace/src /workspace/src
COPY --from=build /workspace/templates /workspace/templates

EXPOSE 4173
CMD ["bun", "server/web-server.ts"]
