import type {
  AccessRouteRecord,
  PrivateNetworkRecord
} from './contracts';
import type { PrivateNetworkRouteObservation } from './provider';

export function applyPrivateNetworkObservation(input: {
  freshnessSeconds: number;
  network: PrivateNetworkRecord;
  observation: PrivateNetworkRouteObservation;
  route: AccessRouteRecord;
}): { network: PrivateNetworkRecord; route: AccessRouteRecord } {
  const { freshnessSeconds, network, observation, route } = input;
  if (freshnessSeconds < 1 || freshnessSeconds > 86_400 ||
    observation.providerKind !== network.providerKind ||
    observation.providerKind !== route.providerKind ||
    route.routeKind !== 'ssh_private_network' ||
    route.privateNetworkId !== network.id) {
    throw new Error('The private-network observation does not match its configured route.');
  }
  const verifiedAt = Date.parse(observation.verifiedAt);
  if (!Number.isFinite(verifiedAt)) {
    throw new Error('The private-network observation has an invalid verification time.');
  }
  const verifiedUntil = new Date(verifiedAt + freshnessSeconds * 1000).toISOString();
  const policyReady = observation.gatewayMember && observation.networkPolicyApproved &&
    observation.targetIdentityRevision === route.targetIdentityRevision;
  const routeAvailability = policyReady ? observation.availability : 'unavailable';
  return {
    network,
    route: {
      ...route,
      availability: routeAvailability,
      lastVerifiedAt: observation.verifiedAt,
      privateAddress: policyReady ? observation.privateAddress : route.privateAddress,
      verifiedUntil
    }
  };
}
