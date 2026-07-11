export const machineConnectionRateLimitSecretEnvironment =
  'PROJECT_SPACE_MACHINE_RATE_LIMIT_SECRET';
export const machineConnectionPublicOriginEnvironment =
  'PROJECT_SPACE_PUBLIC_ORIGIN';

function isLoopbackHostname(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function readMachineConnectionPublicOrigin(
  environment: NodeJS.ProcessEnv = process.env
) {
  const value = environment[machineConnectionPublicOriginEnvironment];
  if (value === undefined || value === '') {
    return null;
  }
  if (value.trim() !== value || /[\0\r\n]/.test(value)) {
    throw new Error('Project Space public origin is not configured securely.');
  }

  try {
    const url = new URL(value);
    const secureProtocol = url.protocol === 'https:';
    const loopbackHttp = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
    if (
      (!secureProtocol && !loopbackHttp) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('invalid origin');
    }
    return url.origin;
  } catch {
    throw new Error('Project Space public origin is not configured securely.');
  }
}

export function readMachineConnectionRateLimitSecret(
  environment: NodeJS.ProcessEnv = process.env
) {
  const value = environment[machineConnectionRateLimitSecretEnvironment];
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') < 32 ||
    Buffer.byteLength(value, 'utf8') > 4_096 ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error('Project Space machine rate-limit secret is not configured securely.');
  }
  return Buffer.from(value, 'utf8');
}
