FROM oven/bun:1.3 AS web
WORKDIR /app
COPY package.json bunfig.toml ./
COPY apps/web/package.json apps/web/package.json
RUN bun install
COPY apps/web apps/web
RUN bun run web:build

FROM golang:1.23 AS backend
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum* ./
RUN go mod download
COPY backend ./
RUN CGO_ENABLED=0 go build -o /out/project-space ./cmd/project-space

FROM gcr.io/distroless/static-debian12
WORKDIR /app
COPY --from=backend /out/project-space /app/project-space
COPY --from=web /app/apps/web/dist /app/apps/web/dist
EXPOSE 4173
ENTRYPOINT ["/app/project-space", "serve"]
