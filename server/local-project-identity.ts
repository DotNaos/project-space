import type { ProjectDiscoveryResult } from '../src/shared/project-space-api';
import { discoverLocalProjects } from './local-project-discovery';

const connectorProjectPrefix = 'connector-project:';
const maximumMachineIdLength = 256;
const maximumLocalProjectIdLength = 1024;
const maximumScopedProjectIdLength =
  connectorProjectPrefix.length + maximumMachineIdLength * 4 + 1 + maximumLocalProjectIdLength * 4;
const controlCharacters = /[\u0000-\u001f\u007f]/;
const canonicalBase64Url = /^[A-Za-z0-9_-]+$/;

type DiscoverProjects = () => Promise<Pick<ProjectDiscoveryResult, 'projects'>>;

export interface ResolveLocalProjectPathOptions {
  discoverProjects?: DiscoverProjects;
}

function isCanonicalText(value: string, maximumLength: number) {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !controlCharacters.test(value)
  );
}

function decodeCanonicalBase64Url(value: string, maximumDecodedLength: number) {
  if (!canonicalBase64Url.test(value)) {
    throw new Error('Connector project identity is invalid.');
  }

  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.length === 0 ||
    bytes.length > maximumDecodedLength * 3 ||
    bytes.toString('base64url') !== value
  ) {
    throw new Error('Connector project identity is invalid.');
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Connector project identity is invalid.');
  }

  if (!isCanonicalText(decoded, maximumDecodedLength)) {
    throw new Error('Connector project identity is invalid.');
  }

  return decoded;
}

function resolveLocalProjectId(machineId: string, projectId: string) {
  if (!isCanonicalText(machineId, maximumMachineIdLength)) {
    throw new Error('Machine identity is invalid.');
  }
  if (!isCanonicalText(projectId, maximumScopedProjectIdLength)) {
    throw new Error('Project identity is invalid.');
  }

  if (!projectId.startsWith(connectorProjectPrefix)) {
    if (!isCanonicalText(projectId, maximumLocalProjectIdLength)) {
      throw new Error('Project identity is invalid.');
    }
    return projectId;
  }

  const encodedParts = projectId.slice(connectorProjectPrefix.length).split(':');
  if (encodedParts.length !== 2) {
    throw new Error('Connector project identity is invalid.');
  }

  const scopedMachineId = decodeCanonicalBase64Url(encodedParts[0]!, maximumMachineIdLength);
  const localProjectId = decodeCanonicalBase64Url(encodedParts[1]!, maximumLocalProjectIdLength);

  if (scopedMachineId !== machineId) {
    throw new Error('Connector project identity does not belong to this machine.');
  }

  return localProjectId;
}

export async function resolveLocalProjectPath(
  machineId: string,
  projectId: string,
  options: ResolveLocalProjectPathOptions = {}
): Promise<string> {
  const localProjectId = resolveLocalProjectId(machineId, projectId);
  const discovery = await (options.discoverProjects ?? discoverLocalProjects)();
  const matches = discovery.projects.filter((project) => project.id === localProjectId);

  if (matches.length !== 1) {
    throw new Error('Local project identity could not be resolved.');
  }

  return matches[0]!.rootPath;
}
