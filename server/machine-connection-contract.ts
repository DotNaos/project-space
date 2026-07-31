export type MachineOperatingSystem = "darwin" | "linux" | "windows";
export type MachineArchitecture = "amd64" | "arm64";

export interface MachineConnectorProfile {
  channel: "dev";
  source: "source";
}

export function machineConnectorProfile(
  channel: unknown,
  source: unknown,
): MachineConnectorProfile | undefined {
  const normalizedChannel = channel ?? null;
  const normalizedSource = source ?? null;
  if (normalizedChannel === null && normalizedSource === null) return undefined;
  if (normalizedChannel === "dev" && normalizedSource === "source") {
    return { channel: "dev", source: "source" };
  }
  throw new Error("Connector profile is invalid.");
}

export function sameMachineConnectorProfile(
  left: MachineConnectorProfile | undefined,
  right: MachineConnectorProfile | undefined,
) {
  return left?.channel === right?.channel && left?.source === right?.source;
}

export function assertSameMachineConnectorProfile(
  enrolled: MachineConnectorProfile | undefined,
  requested: MachineConnectorProfile | undefined,
) {
  if (!sameMachineConnectorProfile(enrolled, requested)) {
    throw new Error("A machine identity cannot change its connector profile.");
  }
}

export interface MachineConnectMetadata {
  architecture: MachineArchitecture;
  clientVersion: string;
  connectorProfile?: MachineConnectorProfile;
  hostname: string;
  name: string;
  operatingSystem: MachineOperatingSystem;
  publicKey: string;
}

export type MachineConnectRequestStatus =
  "pending" | "approved" | "denied" | "consumed" | "expired";

export interface MachineConnectRequestRecord extends MachineConnectMetadata {
  approvalChallenge?: string;
  approvedAt?: string;
  approvedByUserId?: string;
  consumedAt?: string;
  createdAt: string;
  deniedAt?: string;
  expiresAt: string;
  id: string;
  pollTokenHash: string;
  physicalMachineId?: string;
  status: MachineConnectRequestStatus;
}

export interface MachineConnectPhysicalMachine {
  id: string;
  kind: "physical" | "virtual";
  name: string;
}

export interface MachineIdentityRecord {
  architecture: MachineArchitecture;
  clientVersion: string;
  connectorProfile?: MachineConnectorProfile;
  createdAt: string;
  credentialHash: string;
  hostname: string;
  id: string;
  lastSeenAt?: string;
  name: string;
  operatingSystem: MachineOperatingSystem;
  ownerUserId: string;
  publicKey: string;
  revokedAt?: string;
}

export interface TrustedMachineCredentialIdentity {
  connectorProfile?: MachineConnectorProfile;
  hostId: string;
  machineId: string;
  userId: string;
}

export interface MachineConnectRequestResult {
  approvalUrl: string;
  expiresAt: string;
  pollIntervalMs: number;
  pollToken: string;
  requestId: string;
}

export interface MachineConnectApprovalView {
  architecture: MachineArchitecture;
  clientVersion: string;
  connectorProfile?: MachineConnectorProfile;
  expiresAt: string;
  hostname: string;
  name: string;
  operatingSystem: MachineOperatingSystem;
  physicalMachines: MachineConnectPhysicalMachine[];
  status: MachineConnectRequestStatus;
}

export type MachineConnectPollResult =
  | { expiresAt: string; status: "pending" }
  | { approvalChallenge: string; expiresAt: string; status: "approved" }
  | { expiresAt: string; status: "denied" | "expired" | "consumed" };

export interface MachineConnectExchangeResult {
  credential: string;
  issuedAt: string;
  machineId: string;
  machineName: string;
}

export interface MachineConnectionStatusResult {
  lastSeenAt?: string;
  machineId: string;
  machineName: string;
  status: "offline" | "online" | "revoked";
}

export type MachineCredentialMutationResult = "invalid" | "revoked" | "updated";
export type MachineRequestMutationResult = "expired" | "status_mismatch" | "updated";

export type MachineEnrollmentResult =
  | { machine: MachineIdentityRecord; status: "created" | "rotated" }
  | { status: "expired" }
  | { status: "key_conflict" }
  | { status: "request_unavailable" };

export interface MachineConnectionStore {
  consumeRequestAndUpsertMachine(
    request: MachineConnectRequestRecord,
    machine: MachineIdentityRecord,
    unexpiredAt: string,
  ): Promise<MachineEnrollmentResult>;
  createRequest(request: MachineConnectRequestRecord): Promise<void>;
  getMachine(id: string): Promise<MachineIdentityRecord | null>;
  getRequest(id: string): Promise<MachineConnectRequestRecord | null>;
  listPhysicalMachines(userId: string): Promise<MachineConnectPhysicalMachine[]>;
  markMachineOnline(
    machineId: string,
    credentialHash: string,
    lastSeenAt: string,
  ): Promise<MachineCredentialMutationResult>;
  revokeMachine(
    machineId: string,
    credentialHash: string,
    revokedAt: string,
  ): Promise<MachineCredentialMutationResult>;
  updateRequestIfStatus(
    request: MachineConnectRequestRecord,
    expectedStatus: MachineConnectRequestStatus,
    unexpiredAt?: string,
  ): Promise<MachineRequestMutationResult>;
}
