import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import {
  metrics,
  SpanStatusCode,
  trace,
  type Attributes
} from '@opentelemetry/api';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogFields = Record<string, unknown>;

export interface ProjectSpaceLogRecord extends LogFields {
  event: string;
  level: LogLevel;
  service: string;
  timestamp: string;
}

export interface ProjectSpaceLogSink {
  write(record: ProjectSpaceLogRecord): void;
}

export interface ProjectSpaceLogger {
  child(bindings: LogFields): ProjectSpaceLogger;
  debug(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields, error?: unknown): void;
  fatal(event: string, fields?: LogFields, error?: unknown): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields, error?: unknown): void;
}

interface ObservabilityContext extends LogFields {
  requestId?: string;
}

interface LoggerOptions {
  bindings?: LogFields;
  environment?: NodeJS.ProcessEnv;
  level?: LogLevel;
  sink?: ProjectSpaceLogSink;
}

interface InstrumentSet {
  errors: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  httpDuration: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  httpRequests: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  mcpDuration: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  mcpTools: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
}

const observabilityContext = new AsyncLocalStorage<ObservabilityContext>();
const sensitiveKey = /(?:authorization|cookie|credential|password|passphrase|private.?key|secret|token)/i;
const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50
};
let instruments: InstrumentSet | undefined;
let telemetrySdk: { shutdown(): Promise<void> } | undefined;
let telemetryInitializationAttempted = false;

const defaultSink: ProjectSpaceLogSink = {
  write(record) {
    const line = `${JSON.stringify(record)}\n`;
    if (record.level === 'error' || record.level === 'fatal') process.stderr.write(line);
    else process.stdout.write(line);
  }
};

export function createProjectSpaceLogger(options: LoggerOptions = {}): ProjectSpaceLogger {
  const environment = options.environment ?? process.env;
  const minimumLevel = levels[options.level ?? configuredLogLevel(environment)];
  const sink = options.sink ?? defaultSink;
  const base = sanitizeFields({
    service: environment.OTEL_SERVICE_NAME?.trim() ||
      environment.PROJECT_SPACE_BUILD_NAME?.trim() ||
      'project-space',
    environment: environment.PROJECT_DEPLOY_ENVIRONMENT?.trim() ||
      environment.PROJECT_ENV?.trim() ||
      environment.NODE_ENV?.trim(),
    version: environment.PROJECT_SPACE_BUILD_VERSION?.trim(),
    releaseId: environment.PROJECT_SPACE_RELEASE_ID?.trim(),
    commit: environment.PROJECT_SPACE_BUILD_COMMIT?.trim() ||
      environment.PROJECT_SPACE_BUILD_ID?.trim(),
    ...options.bindings
  });

  const create = (bindings: LogFields): ProjectSpaceLogger => {
    const bound = { ...base, ...sanitizeFields(bindings) };
    const emit = (level: LogLevel, event: string, fields?: LogFields, error?: unknown) => {
      if (levels[level] < minimumLevel) return;
      const activeSpan = trace.getActiveSpan()?.spanContext();
      const context = observabilityContext.getStore();
      const record = {
        ...bound,
        ...sanitizeFields(context ?? {}),
        ...(activeSpan ? { spanId: activeSpan.spanId, traceId: activeSpan.traceId } : {}),
        ...sanitizeFields(fields ?? {}),
        ...(error === undefined ? {} : { error: serializeError(error) }),
        event,
        level,
        timestamp: new Date().toISOString()
      } as ProjectSpaceLogRecord;
      sink.write(record);
    };
    return {
      child(childBindings) {
        return create({ ...bindings, ...childBindings });
      },
      debug: (event, fields) => emit('debug', event, fields),
      error: (event, fields, error) => emit('error', event, fields, error),
      fatal: (event, fields, error) => emit('fatal', event, fields, error),
      info: (event, fields) => emit('info', event, fields),
      warn: (event, fields, error) => emit('warn', event, fields, error)
    };
  };

  return create({});
}

export const projectSpaceLogger = createProjectSpaceLogger();

export function createRequestId(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header[0] : header;
  return value && /^[A-Za-z0-9._:-]{8,128}$/.test(value) ? value : randomUUID();
}

export function currentRequestId() {
  return observabilityContext.getStore()?.requestId;
}

export function runWithObservabilityContext<Result>(
  context: ObservabilityContext,
  callback: () => Result
) {
  return observabilityContext.run(context, callback);
}

export async function withProjectSpaceSpan<Result>(
  name: string,
  attributes: Attributes,
  callback: () => Promise<Result>
) {
  return trace.getTracer('project-space').startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await callback();
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function recordHttpRequest(method: string, route: string, status: number, durationMs: number) {
  const attributes = { 'http.request.method': method, 'http.route': route, 'http.response.status_code': status };
  getInstruments().httpRequests.add(1, attributes);
  getInstruments().httpDuration.record(durationMs, attributes);
  if (status >= 500) recordObservedError('http', String(status));
}

export function recordMcpTool(name: string, failed: boolean, durationMs: number) {
  const attributes = { 'mcp.tool.name': name, 'error.type': failed ? 'tool_error' : 'none' };
  getInstruments().mcpTools.add(1, attributes);
  getInstruments().mcpDuration.record(durationMs, attributes);
  if (failed) recordObservedError('mcp.tool', name);
}

export function recordObservedError(component: string, code: string) {
  getInstruments().errors.add(1, { component, 'error.type': code });
}

export async function initializeOpenTelemetry(
  logger: ProjectSpaceLogger = projectSpaceLogger,
  environment: NodeJS.ProcessEnv = process.env
) {
  if (telemetryInitializationAttempted) return telemetrySdk !== undefined;
  telemetryInitializationAttempted = true;
  if (!openTelemetryConfigured(environment)) {
    logger.debug('observability.opentelemetry.disabled');
    return false;
  }

  try {
    environment.OTEL_SERVICE_NAME ||= environment.PROJECT_SPACE_BUILD_NAME || 'project-space';
    const hasOtlpEndpoint = Boolean(
      environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
      environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
      environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim()
    );
    environment.OTEL_TRACES_EXPORTER ||= hasOtlpEndpoint ? 'otlp' : 'none';
    environment.OTEL_METRICS_EXPORTER ||= hasOtlpEndpoint ? 'otlp' : 'none';
    environment.OTEL_LOGS_EXPORTER ||= 'none';
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const sdk = new NodeSDK({ serviceName: environment.OTEL_SERVICE_NAME });
    sdk.start();
    telemetrySdk = sdk;
    logger.info('observability.opentelemetry.started', {
      tracesExporter: environment.OTEL_TRACES_EXPORTER,
      metricsExporter: environment.OTEL_METRICS_EXPORTER
    });
    return true;
  } catch (error) {
    logger.error('observability.opentelemetry.start_failed', {}, error);
    return false;
  }
}

export async function shutdownOpenTelemetry(logger: ProjectSpaceLogger = projectSpaceLogger) {
  const sdk = telemetrySdk;
  telemetrySdk = undefined;
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (error) {
    logger.error('observability.opentelemetry.shutdown_failed', {}, error);
  }
}

export function installProcessErrorHandlers(logger: ProjectSpaceLogger = projectSpaceLogger) {
  const rejection = (error: unknown) => {
    recordObservedError('process', 'unhandled_rejection');
    logger.error('process.unhandled_rejection', {}, error);
  };
  const exception = (error: Error) => {
    recordObservedError('process', 'uncaught_exception');
    logger.fatal('process.uncaught_exception', {}, error);
    void shutdownOpenTelemetry(logger).finally(() => process.exit(1));
  };
  process.on('unhandledRejection', rejection);
  process.on('uncaughtException', exception);
  return () => {
    process.off('unhandledRejection', rejection);
    process.off('uncaughtException', exception);
  };
}

function configuredLogLevel(environment: NodeJS.ProcessEnv): LogLevel {
  const value = environment.PROJECT_SPACE_LOG_LEVEL?.trim().toLowerCase();
  return value && value in levels ? value as LogLevel : 'info';
}

function openTelemetryConfigured(environment: NodeJS.ProcessEnv) {
  if (environment.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return false;
  const exporterEnabled = (value: string | undefined) => {
    const normalized = value?.trim().toLowerCase();
    return Boolean(normalized && normalized !== 'none');
  };
  return Boolean(
    environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim() ||
    exporterEnabled(environment.OTEL_TRACES_EXPORTER) ||
    exporterEnabled(environment.OTEL_METRICS_EXPORTER)
  );
}

function getInstruments(): InstrumentSet {
  if (instruments) return instruments;
  const meter = metrics.getMeter('project-space');
  instruments = {
    errors: meter.createCounter('project_space_errors_total'),
    httpDuration: meter.createHistogram('project_space_http_request_duration_ms', { unit: 'ms' }),
    httpRequests: meter.createCounter('project_space_http_requests_total'),
    mcpDuration: meter.createHistogram('project_space_mcp_tool_duration_ms', { unit: 'ms' }),
    mcpTools: meter.createCounter('project_space_mcp_tools_total')
  };
  return instruments;
}

function sanitizeFields(value: LogFields): LogFields {
  return sanitizeValue(value, new WeakSet(), 0) as LogFields;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return redactString(value).slice(0, 16_384);
  if (typeof value !== 'object') return String(value);
  if (depth >= 8) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeValue(entry, seen, depth + 1));
  const result: LogFields = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    result[entryKey] = sanitizeValue(entryValue, seen, depth + 1, entryKey);
  }
  return result;
}

function redactString(value: string) {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|gh[opsu]|github_pat)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
}

function serializeError(error: unknown): LogFields {
  if (!(error instanceof Error)) return { message: redactString(String(error)), type: typeof error };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return sanitizeFields({
    code,
    message: error.message,
    name: error.name,
    stack: error.stack,
    ...(error.cause instanceof Error ? { cause: serializeError(error.cause) } : {})
  });
}
