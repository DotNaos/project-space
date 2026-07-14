import { isConnectorRuntimeMaintenanceEvidence } from './connector-runtime-registration-decision';

const semanticVersionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const buildIdPattern = /^[0-9a-f]{40}$/;
const protocolVersionPattern = /^[1-9][0-9]{0,7}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function metadata(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function isManagedTarget(platform: unknown, architecture: unknown) {
  return (platform === 'darwin' && architecture === 'arm64') ||
    ((platform === 'linux' || platform === 'windows') && architecture === 'x64');
}

function isCanonicalTimestamp(value: unknown) {
  if (!metadata(value, 64)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function isConnectorRuntimeMetadata(value: unknown) {
  if (value === undefined) return true;
  if (!isRecord(value) || !isRecord(value.bundleVersions)) return false;
  const expectedKeys = [
    'architecture', 'buildId', 'bundleVersions', 'channel', 'instanceId', 'lastCheckedAt',
    'platform', 'protocolVersion', 'releaseId', 'source', 'version'
  ];
  if (value.maintenance !== undefined) expectedKeys.push('maintenance');
  if (!hasExactKeys(value, expectedKeys) ||
      !hasExactKeys(value.bundleVersions, ['connector', 'machineTools', 'projectCli']) ||
      (value.maintenance !== undefined &&
        !isConnectorRuntimeMaintenanceEvidence(value.maintenance)) ||
      !semanticVersionPattern.test(String(value.version)) ||
      !semanticVersionPattern.test(String(value.bundleVersions.connector)) ||
      !semanticVersionPattern.test(String(value.bundleVersions.machineTools)) ||
      !semanticVersionPattern.test(String(value.bundleVersions.projectCli)) ||
      !metadata(value.buildId, 128) || !metadata(value.instanceId, 128) ||
      !metadata(value.releaseId, 128) || String(value.releaseId).toLowerCase() === 'latest' ||
      !protocolVersionPattern.test(String(value.protocolVersion)) ||
      !isCanonicalTimestamp(value.lastCheckedAt) ||
      (value.channel !== 'stable' && value.channel !== 'beta' && value.channel !== 'dev') ||
      (value.source !== 'managed' && value.source !== 'homebrew' && value.source !== 'winget' &&
        value.source !== 'source' && value.source !== 'legacy' && value.source !== 'unknown') ||
      (value.platform !== 'darwin' && value.platform !== 'linux' && value.platform !== 'windows') ||
      (value.architecture !== 'arm64' && value.architecture !== 'x64')) {
    return false;
  }
  return value.source !== 'managed' ||
    (isManagedTarget(value.platform, value.architecture) &&
      (value.channel === 'stable' || value.channel === 'beta') &&
      buildIdPattern.test(String(value.buildId)) && value.releaseId === `v${value.version}`);
}
