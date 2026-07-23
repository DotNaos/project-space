FROM oven/bun:1 AS deps

WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS build

WORKDIR /workspace
ARG PROJECT_SPACE_BUILD_COMMIT
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_PROJECT_SPACE_API_BASE_URL=
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
COPY --from=deps /workspace/node_modules /workspace/node_modules
COPY . .
RUN test -n "$PROJECT_SPACE_BUILD_COMMIT" \
  && test -n "$VITE_CLERK_PUBLISHABLE_KEY" \
  && bun run build

FROM golang:1.26-bookworm AS cli-build
WORKDIR /workspace
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -o /project ./cmd/project

FROM oven/bun:1 AS runner

WORKDIR /workspace
ARG PROJECT_SPACE_BUILD_COMMIT
LABEL org.opencontainers.image.revision=$PROJECT_SPACE_BUILD_COMMIT
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PROJECT_SPACE_HOST=0.0.0.0
ENV PROJECT_SPACE_PORT=4173
COPY --from=build /workspace/bin /workspace/bin
COPY --from=cli-build /project /workspace/bin/project
COPY --from=build /workspace/dist/renderer /workspace/dist/renderer
COPY --from=build /workspace/package.json /workspace/package.json
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build /workspace/server /workspace/server
COPY --from=build /workspace/src /workspace/src
EXPOSE 4173
CMD ["bun", "server/web-server.ts"]
