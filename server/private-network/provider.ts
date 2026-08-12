import type {
  PrivateNetworkAvailability,
  PrivateNetworkProviderKind
} from './contracts';

export interface PrivateNetworkRouteObservation {
  availability: PrivateNetworkAvailability;
  gatewayMember: boolean;
  networkPolicyApproved: boolean;
  privateAddress: string;
  providerKind: PrivateNetworkProviderKind;
  targetIdentityRevision: string;
  verifiedAt: string;
}

export interface PrivateNetworkProviderAdapter<Input> {
  readonly providerKind: PrivateNetworkProviderKind;
  observe(input: Input): PrivateNetworkRouteObservation;
}
