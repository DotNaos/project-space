FROM oven/bun:1.3.14 AS bun-runtime

FROM bun-runtime AS deps

WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM node:24.11.1-bookworm-slim AS mobile-build

WORKDIR /workspace
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY package.json ./
COPY apps/mobile/package.json apps/mobile/bun.lock ./apps/mobile/
RUN cd apps/mobile && bun install --frozen-lockfile
COPY apps/mobile ./apps/mobile
COPY src ./src
COPY config ./config
COPY apps/docs/content/docs/changelog/entries.json \
  ./apps/docs/content/docs/changelog/entries.json
RUN cd apps/mobile && bun run build:prototype

FROM oven/bun:1.3.14 AS build

WORKDIR /workspace
ARG VITE_CLERK_PUBLISHABLE_KEY=
ENV VITE_PROJECT_SPACE_API_BASE_URL=
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
COPY --from=deps /workspace/node_modules /workspace/node_modules
COPY . .
RUN bun run build:web
COPY --from=mobile-build /workspace/apps/mobile/dist-prototype /workspace/apps/mobile/dist-prototype

FROM golang:1.26-bookworm AS cli-build
WORKDIR /workspace
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -o /project ./cmd/project \
  && CGO_ENABLED=0 go build -trimpath -o /tailscale-status-proxy ./cmd/tailscale-status-proxy

FROM scratch AS tailscale-status-runner

COPY --from=cli-build /tailscale-status-proxy /tailscale-status-proxy
USER 65534:65534
EXPOSE 4180
ENTRYPOINT ["/tailscale-status-proxy"]

FROM oven/bun:1.3.14 AS runner

WORKDIR /workspace
ARG PROJECT_SPACE_BUILD_COMMIT=unknown
LABEL org.opencontainers.image.revision=$PROJECT_SPACE_BUILD_COMMIT
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client \
  && git config --system --add safe.directory /workspace/backend-repo \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PROJECT_SPACE_HOST=0.0.0.0
ENV PROJECT_SPACE_PORT=4173

COPY --from=build /workspace/bin /workspace/bin
COPY --from=cli-build /project /workspace/bin/project
COPY --from=build /workspace/dist/renderer /workspace/dist/renderer
COPY --from=build /workspace/apps/docs/lib/releases /workspace/apps/docs/lib/releases
COPY --from=build /workspace/package.json /workspace/package.json
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build /workspace/server /workspace/server
COPY --from=build /workspace/src /workspace/src
RUN bun -e "await import('./server/project-space-api-public-routes.ts')"

EXPOSE 4173
CMD ["bun", "server/web-server.ts"]
