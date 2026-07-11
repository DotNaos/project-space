import type { Readable } from 'node:stream';

export const connectorRuntimeCredentialVersion =
  'project-space.connector-runtime/v1';
export const connectorRuntimeProtocolEnvironment =
  'PROJECT_SPACE_CONNECTOR_RUNTIME_PROTOCOL';

const maximumRuntimeCredentialBytes = 16 * 1024;
const identifierPattern = /^[A-Za-z0-9_.~-]{1,256}$/;

export interface ConnectorRuntimeCredential {
  backendUrl: string;
  credential: string;
  machineId: string;
  version: typeof connectorRuntimeCredentialVersion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOpaque(value: unknown) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.trim() === value &&
    !/[\r\n\0]/.test(value)
  );
}

function isSecureBackendUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 4096 || value.trim() !== value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const loopback = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
    return (
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))
    );
  } catch {
    return false;
  }
}

function parseRuntimeCredential(payload: string): ConnectorRuntimeCredential {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw new Error('Connector runtime credential is not valid JSON.');
  }
  if (!isRecord(decoded)) {
    throw new Error('Connector runtime credential is invalid.');
  }
  const fields = Object.keys(decoded).sort();
  if (fields.join(',') !== 'backendUrl,credential,machineId,version') {
    throw new Error('Connector runtime credential has unexpected fields.');
  }
  if (
    decoded.version !== connectorRuntimeCredentialVersion ||
    !isSecureBackendUrl(decoded.backendUrl) ||
    typeof decoded.machineId !== 'string' ||
    !identifierPattern.test(decoded.machineId) ||
    !isOpaque(decoded.credential)
  ) {
    throw new Error('Connector runtime credential is invalid.');
  }
  return decoded as unknown as ConnectorRuntimeCredential;
}

export async function readConnectorRuntimeCredential(
  input: Pick<Readable, typeof Symbol.asyncIterator>,
  environment: NodeJS.ProcessEnv = process.env
) {
  if (
    environment[connectorRuntimeProtocolEnvironment] !==
    connectorRuntimeCredentialVersion
  ) {
    return null;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maximumRuntimeCredentialBytes) {
      throw new Error('Connector runtime credential is too large.');
    }
    chunks.push(bytes);
  }
  return parseRuntimeCredential(Buffer.concat(chunks).toString('utf8'));
}
