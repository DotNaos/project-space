export const CODEX_RUNTIME_VERSION_CAPABILITY_PREFIX =
  'codex.runtime.version.' as const;

const codexRuntimeVersionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function codexRuntimeVersionCapability(version: string) {
  if (!codexRuntimeVersionPattern.test(version)) {
    throw new Error('The managed Codex runtime version must be an exact semantic version.');
  }
  return `${CODEX_RUNTIME_VERSION_CAPABILITY_PREFIX}${version}`;
}

export function codexRuntimeVersionFromCapability(capability: string) {
  if (!capability.startsWith(CODEX_RUNTIME_VERSION_CAPABILITY_PREFIX)) {
    return undefined;
  }
  const version = capability.slice(CODEX_RUNTIME_VERSION_CAPABILITY_PREFIX.length);
  return codexRuntimeVersionPattern.test(version) ? version : undefined;
}

export function codexRuntimeVersionFromCapabilities(
  capabilities: readonly string[]
) {
  const matches = capabilities.filter((capability) =>
    capability.startsWith(CODEX_RUNTIME_VERSION_CAPABILITY_PREFIX)
  );
  if (matches.length !== 1) return undefined;
  return codexRuntimeVersionFromCapability(matches[0]!);
}
