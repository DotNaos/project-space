---
title: Observability
description: Structured logs, correlation, OpenTelemetry export, and production error triage.
---

# Observability

Project Space writes one JSON object per log line to stdout or stderr. Error records include a stack trace and carry the active HTTP request ID plus OpenTelemetry trace and span IDs when tracing is enabled. Authorization headers, cookies, credentials, passwords, private keys, secrets, and token-shaped fields are redacted before a record reaches the sink.

Every HTTP response exposes its correlation value as `X-Request-ID`. A valid incoming `X-Request-ID` is preserved; otherwise Project Space generates a UUID. MCP protocol and tool logs use the same request context, so a client-visible request ID can be followed through OAuth, session, transport, and tool boundaries.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PROJECT_SPACE_LOG_LEVEL` | Minimum JSON log level: `debug`, `info`, `warn`, `error`, or `fatal` | `info` |
| `OTEL_SDK_DISABLED` | Set to `true` to disable OpenTelemetry | disabled unless an exporter is configured |
| `OTEL_SERVICE_NAME` | OpenTelemetry service name | Project Space build name or `project-space` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector base URL | unset |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Optional dedicated traces endpoint | unset |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Optional dedicated metrics endpoint | unset |
| `OTEL_EXPORTER_OTLP_HEADERS` | Collector authentication headers | unset |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | OTLP transport configured through the OpenTelemetry SDK | SDK default |

Local development does not require a collector. When no OpenTelemetry exporter variable is present, the SDK remains disabled while structured logs and correlation continue to work.

## Signals

The initial instrumentation emits:

- structured HTTP completion and boundary-failure logs;
- structured MCP authentication, session, protocol, and tool logs;
- fatal process logs for uncaught exceptions and unhandled-rejection logs;
- HTTP request count and duration metrics;
- MCP tool count and duration metrics;
- a shared error counter tagged by component and error type;
- manual HTTP and MCP tool spans correlated with logs.

Every deployed log also includes the available environment, version, release ID, and commit metadata.

## Filtering production errors

Docker captures the JSON stream. Until an OTLP-compatible backend is connected, recent production errors can be filtered directly on the VPS:

```sh
docker compose -f deploy/compose.yml logs --no-log-prefix web \
  | jq -R 'fromjson? | select(.level == "error" or .level == "fatal")'
```

Find one incident by request ID:

```sh
docker compose -f deploy/compose.yml logs --no-log-prefix web \
  | jq -R --arg id "$REQUEST_ID" 'fromjson? | select(.requestId == $id)'
```

Production should point the OTLP variables at a collector and configure the selected backend to alert on `process.uncaught_exception`, `process.unhandled_rejection`, `mcp.request.failed`, HTTP 5xx rates, and the `project_space_errors_total` metric. Collector credentials belong in the deployment secret store and must never be committed or printed.
