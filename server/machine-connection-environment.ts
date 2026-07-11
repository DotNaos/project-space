export const machineConnectionRateLimitSecretEnvironment =
  'PROJECT_SPACE_MACHINE_RATE_LIMIT_SECRET';

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
