const forbiddenKey = /(token|secret|password|credential|device.?code|user.?code|login.?id|transcript|(?:^|_)path|url)/i;
const unsafeString = /(?:https?:|file:)|(?:^|[\s("'=:\[])\/(?:[A-Za-z0-9._~-]|$)|(?:^|[\s("'=:\[])(?:~\/|[A-Za-z]:[\\/])|\b[A-Za-z0-9._~-]+\/[A-Za-z0-9._~/-]+\b/i;

export function assertSafeTaskExecutionResult(
  result: Record<string, unknown> | undefined
): void {
  if (result === undefined) return;
  const serialized = JSON.stringify(result);
  if (serialized.length > 16_384) throw new Error('Task Execution operation result is too large.');
  inspect(result, 0);
}

function inspect(value: unknown, depth: number): void {
  if (depth > 5) throw new Error('Task Execution operation result is too deeply nested.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Task Execution operation result is invalid.');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 2_000 || unsafeString.test(value)) {
      throw new Error('Task Execution operation result contains unsafe data.');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('Task Execution operation result is too large.');
    value.forEach((entry) => inspect(entry, depth + 1));
    return;
  }
  if (typeof value !== 'object') throw new Error('Task Execution operation result is invalid.');
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('Task Execution operation result is too large.');
  for (const [key, entry] of entries) {
    const canonicalKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.\s]+/g, '_');
    if (forbiddenKey.test(canonicalKey)) {
      throw new Error('Task Execution operation result contains a forbidden field.');
    }
    inspect(entry, depth + 1);
  }
}

export function sameSafeResult(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined
) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
