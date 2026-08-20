interface EnvironmentDefinitionSignature {
  bootstrap_strategy: string;
  kind: string;
  name: string;
  operating_system_family: string;
  ownership: string;
  slug: string;
  supported_architectures: readonly string[];
}

interface EnvironmentRepairSignature {
  environment_definition_id: string;
  host_evidence: string;
  host_id: string | null;
  host_resolution: string;
  identity_resolution: string;
  kind: string;
  name: string;
  owner_user_id: string;
  resource_mode: string;
}

export function isRepairedTailscaleEnvironmentCopy(
  userEnvironment: EnvironmentRepairSignature,
  deploymentEnvironment: EnvironmentRepairSignature,
  definitionsByKey: ReadonlyMap<string, EnvironmentDefinitionSignature>
) {
  const userDefinition = definitionsByKey.get(
    `${userEnvironment.owner_user_id}\u0000${userEnvironment.environment_definition_id}`
  );
  const deploymentDefinition = definitionsByKey.get(
    `${deploymentEnvironment.owner_user_id}\u0000${deploymentEnvironment.environment_definition_id}`
  );
  return userDefinition?.ownership === 'built_in' &&
    deploymentDefinition?.ownership === 'built_in' &&
    equivalentBuiltInDefinition(userDefinition, deploymentDefinition) &&
    userEnvironment.host_resolution === 'manual' &&
    userEnvironment.host_evidence === 'user' &&
    userEnvironment.host_id !== null &&
    userEnvironment.identity_resolution === 'resolved' &&
    userEnvironment.kind === deploymentEnvironment.kind &&
    userEnvironment.name === deploymentEnvironment.name &&
    userEnvironment.resource_mode === deploymentEnvironment.resource_mode;
}

function equivalentBuiltInDefinition(
  left: EnvironmentDefinitionSignature,
  right: EnvironmentDefinitionSignature
) {
  return left.bootstrap_strategy === right.bootstrap_strategy &&
    left.kind === right.kind &&
    left.name === right.name &&
    left.operating_system_family === right.operating_system_family &&
    left.slug === right.slug &&
    JSON.stringify([...left.supported_architectures].sort()) ===
      JSON.stringify([...right.supported_architectures].sort());
}
