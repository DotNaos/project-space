import { randomBytes, randomUUID } from "node:crypto";

import type {
  MachineConnectApprovalView,
  MachineConnectExchangeResult,
  MachineConnectMetadata,
  MachineConnectPollResult,
  MachineConnectRequestRecord,
  MachineConnectRequestResult,
  MachineConnectionStatusResult,
  MachineConnectionStore,
  MachineIdentityRecord,
} from "./machine-connection-contract";
import {
  approvalProofMessage,
  base64Url,
  equalSecretHash,
  secretHash,
  verifyApprovalProof,
} from "./machine-connection-crypto";
import { MachineConnectionError } from "./machine-connection-error";

export { MachineConnectionError } from "./machine-connection-error";

const defaultRequestLifetimeMs = 10 * 60_000;
const defaultPollIntervalMs = 2_000;
const invalidCredentialHash = secretHash("invalid-machine-credential");
const machineNamePattern = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const hostnamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const physicalMachineIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;

interface MachineConnectionServiceOptions {
  isMachineOnline?: (
    machineId: string,
    credential: string,
  ) => boolean | Promise<boolean>;
  now?: () => Date;
  onMachineRevoked?: (machineId: string) => void | Promise<void>;
  pollIntervalMs?: number;
  publicOrigin: string;
  requestLifetimeMs?: number;
  store: MachineConnectionStore;
}

function requireRequestToken(
  request: MachineConnectRequestRecord,
  pollToken: string,
) {
  if (!pollToken || !equalSecretHash(request.pollTokenHash, pollToken)) {
    throw new MachineConnectionError(
      "Connection request was not found.",
      "not_found",
    );
  }
}

function normalizeMetadata(
  metadata: MachineConnectMetadata,
): MachineConnectMetadata {
  const normalized = {
    ...metadata,
    clientVersion: metadata.clientVersion.trim(),
    hostname: metadata.hostname.trim(),
    name: metadata.name.trim(),
    publicKey: metadata.publicKey.trim(),
  };

  if (
    !machineNamePattern.test(normalized.name) ||
    !hostnamePattern.test(normalized.hostname) ||
    !versionPattern.test(normalized.clientVersion) ||
    (normalized.connectorProfile !== undefined &&
      (normalized.connectorProfile.channel !== "dev" ||
        normalized.connectorProfile.source !== "source")) ||
    !["amd64", "arm64"].includes(normalized.architecture) ||
    !["darwin", "linux", "windows"].includes(normalized.operatingSystem)
  ) {
    throw new MachineConnectionError(
      "Machine metadata is invalid.",
      "invalid_input",
    );
  }

  let publicKeyBytes: Buffer;
  try {
    publicKeyBytes = Buffer.from(normalized.publicKey, "base64url");
  } catch {
    throw new MachineConnectionError(
      "Machine public key is invalid.",
      "invalid_input",
    );
  }
  if (
    publicKeyBytes.length !== 32 ||
    base64Url(publicKeyBytes) !== normalized.publicKey
  ) {
    throw new MachineConnectionError(
      "Machine public key is invalid.",
      "invalid_input",
    );
  }

  return normalized;
}

export class MachineConnectionService {
  private readonly isMachineOnline: (
    machineId: string,
    credential: string,
  ) => boolean | Promise<boolean>;
  private readonly now: () => Date;
  private readonly onMachineRevoked: (machineId: string) => void | Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly publicOrigin: string;
  private readonly requestLifetimeMs: number;
  private readonly store: MachineConnectionStore;

  constructor(options: MachineConnectionServiceOptions) {
    const origin = new URL(options.publicOrigin);
    if (
      origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(origin.hostname)
      )
    ) {
      throw new Error("Machine connection public origin must use HTTPS.");
    }
    this.publicOrigin = origin.origin;
    this.store = options.store;
    this.isMachineOnline = options.isMachineOnline ?? (() => false);
    this.now = options.now ?? (() => new Date());
    this.onMachineRevoked = options.onMachineRevoked ?? (() => {});
    this.requestLifetimeMs =
      options.requestLifetimeMs ?? defaultRequestLifetimeMs;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  }

  async createRequest(
    metadata: MachineConnectMetadata,
  ): Promise<MachineConnectRequestResult> {
    const normalized = normalizeMetadata(metadata);
    const now = this.now();
    const requestId = randomUUID();
    const pollToken = base64Url(randomBytes(32));
    const expiresAt = new Date(
      now.getTime() + this.requestLifetimeMs,
    ).toISOString();

    await this.store.createRequest({
      ...normalized,
      createdAt: now.toISOString(),
      expiresAt,
      id: requestId,
      pollTokenHash: secretHash(pollToken),
      status: "pending",
    });

    const approvalUrl = new URL("/connector/connect", this.publicOrigin);
    approvalUrl.searchParams.set("request", requestId);

    return {
      approvalUrl: approvalUrl.toString(),
      expiresAt,
      pollIntervalMs: this.pollIntervalMs,
      pollToken,
      requestId,
    };
  }

  async getApprovalView(
    requestId: string,
    userId: string,
  ): Promise<MachineConnectApprovalView> {
    const request = await this.expireIfNeeded(
      await this.requireRequest(requestId),
    );
    return {
      architecture: request.architecture,
      clientVersion: request.clientVersion,
      connectorProfile: request.connectorProfile,
      expiresAt: request.expiresAt,
      hostname: request.hostname,
      name: request.name,
      operatingSystem: request.operatingSystem,
      physicalMachines: await this.store.listPhysicalMachines(userId),
      status: request.status,
    };
  }

  async pollRequest(
    requestId: string,
    pollToken: string,
  ): Promise<MachineConnectPollResult> {
    const request = await this.requireRequest(requestId);
    requireRequestToken(request, pollToken);
    const current = await this.expireIfNeeded(request);

    if (current.status === "approved" && current.approvalChallenge) {
      return {
        approvalChallenge: current.approvalChallenge,
        expiresAt: current.expiresAt,
        status: "approved",
      };
    }
    if (current.status === "pending") {
      return { expiresAt: current.expiresAt, status: "pending" };
    }
    if (
      current.status === "denied" ||
      current.status === "expired" ||
      current.status === "consumed"
    ) {
      return { expiresAt: current.expiresAt, status: current.status };
    }
    throw new Error("Approved connection request is missing its challenge.");
  }

  async approveRequest(
    requestId: string,
    userId: string,
    physicalMachineId: string,
  ) {
    const request = await this.expireIfNeeded(
      await this.requireRequest(requestId),
    );
    if (!userId.trim()) {
      throw new MachineConnectionError(
        "Authenticated user is required.",
        "invalid_input",
      );
    }
    const normalizedPhysicalMachineId = physicalMachineId.trim();
    if (!physicalMachineIdPattern.test(normalizedPhysicalMachineId)) {
      throw new MachineConnectionError(
        "Select a machine before approving this connector.",
        "invalid_input",
      );
    }
    if (request.status === "expired") {
      throw new MachineConnectionError(
        "Connection request expired.",
        "expired",
      );
    }
    if (request.status !== "pending") {
      throw new MachineConnectionError(
        "Connection request was already decided.",
        "already_decided",
      );
    }
    const physicalMachine = (await this.store.listPhysicalMachines(userId.trim()))
      .find((candidate) => candidate.id === normalizedPhysicalMachineId);
    if (!physicalMachine) {
      throw new MachineConnectionError(
        "The selected machine is unavailable for this account.",
        "invalid_input",
      );
    }

    const approvedAt = this.now().toISOString();
    const approved: MachineConnectRequestRecord = {
      ...request,
      approvalChallenge: base64Url(randomBytes(32)),
      approvedAt,
      approvedByUserId: userId.trim(),
      physicalMachineId: physicalMachine.id,
      status: "approved",
    };
    const approvalResult = await this.store.updateRequestIfStatus(
      approved,
      "pending",
      approvedAt,
    );
    if (approvalResult === "expired") {
      throw new MachineConnectionError(
        "Connection request expired.",
        "expired",
      );
    }
    if (approvalResult !== "updated") {
      throw new MachineConnectionError(
        "Connection request was already decided.",
        "already_decided",
      );
    }
    return { status: "approved" as const };
  }

  async denyRequest(requestId: string, userId: string) {
    const request = await this.expireIfNeeded(
      await this.requireRequest(requestId),
    );
    if (!userId.trim()) {
      throw new MachineConnectionError(
        "Authenticated user is required.",
        "invalid_input",
      );
    }
    if (request.status === "expired") {
      throw new MachineConnectionError(
        "Connection request expired.",
        "expired",
      );
    }
    if (request.status !== "pending") {
      throw new MachineConnectionError(
        "Connection request was already decided.",
        "already_decided",
      );
    }
    const deniedAt = this.now().toISOString();
    const denialResult = await this.store.updateRequestIfStatus(
      {
        ...request,
        deniedAt,
        status: "denied",
      },
      "pending",
      deniedAt,
    );
    if (denialResult === "expired") {
      throw new MachineConnectionError(
        "Connection request expired.",
        "expired",
      );
    }
    if (denialResult !== "updated") {
      throw new MachineConnectionError(
        "Connection request was already decided.",
        "already_decided",
      );
    }
    return { status: "denied" as const };
  }

  async exchangeApproval(
    requestId: string,
    pollToken: string,
    signature: string,
  ): Promise<MachineConnectExchangeResult> {
    const request = await this.requireRequest(requestId);
    requireRequestToken(request, pollToken);
    const current = await this.expireIfNeeded(request);

    if (current.status === "pending") {
      throw new MachineConnectionError(
        "Connection request is still pending.",
        "pending",
      );
    }
    if (current.status === "expired") {
      throw new MachineConnectionError(
        "Connection request expired.",
        "expired",
      );
    }
    if (current.status === "denied") {
      throw new MachineConnectionError(
        "Connection request was denied.",
        "denied",
      );
    }
    if (current.status === "consumed") {
      throw new MachineConnectionError(
        "Connection request was already used.",
        "already_used",
      );
    }
    if (!current.approvedByUserId || !verifyApprovalProof(current, signature)) {
      throw new MachineConnectionError(
        "Machine key proof is invalid.",
        "invalid_proof",
      );
    }
    if (!current.physicalMachineId) {
      throw new MachineConnectionError(
        "Connector approval is missing its machine assignment.",
        "invalid_proof",
      );
    }

    const now = this.now().toISOString();
    const machineId = randomUUID();
    const credential = base64Url(randomBytes(32));
    const machine: MachineIdentityRecord = {
      architecture: current.architecture,
      clientVersion: current.clientVersion,
      connectorProfile: current.connectorProfile,
      createdAt: now,
      credentialHash: secretHash(credential),
      hostname: current.hostname,
      id: machineId,
      name: current.name,
      operatingSystem: current.operatingSystem,
      ownerUserId: current.approvedByUserId,
      publicKey: current.publicKey,
    };

    const enrollment = await this.store.consumeRequestAndUpsertMachine(
      { ...current, consumedAt: now, status: "consumed" },
      machine,
      now,
    );
    if (enrollment.status === "expired") {
      throw new MachineConnectionError(
        "Connection request expired.",
        "expired",
      );
    }
    if (enrollment.status === "key_conflict") {
      throw new MachineConnectionError(
        "Machine key is already owned by another account.",
        "invalid_proof",
      );
    }
    if (enrollment.status === "request_unavailable") {
      throw new MachineConnectionError(
        "Connection request was already used.",
        "already_used",
      );
    }

    return {
      credential,
      issuedAt: now,
      machineId: enrollment.machine.id,
      machineName: enrollment.machine.name,
    };
  }

  async getConnectionStatus(
    machineId: string,
    credential: string,
  ): Promise<MachineConnectionStatusResult> {
    const machine = await this.authenticateMachine(machineId, credential, true);
    const online =
      !machine.revokedAt &&
      (await this.isMachineOnline(machine.id, credential));
    return {
      lastSeenAt: machine.lastSeenAt,
      machineId: machine.id,
      machineName: machine.name,
      status: machine.revokedAt ? "revoked" : online ? "online" : "offline",
    };
  }

  async markMachineOnline(machineId: string, credential: string) {
    await this.authenticateMachine(machineId, credential);
    const result = await this.store.markMachineOnline(
      machineId,
      secretHash(credential),
      this.now().toISOString(),
    );
    if (result === "invalid") {
      throw new MachineConnectionError(
        "Machine credential is invalid.",
        "invalid_credential",
      );
    }
    if (result === "revoked") {
      throw new MachineConnectionError("Machine was revoked.", "revoked");
    }
    return this.authenticateMachine(machineId, credential);
  }

  async revokeMachine(machineId: string, credential: string) {
    const result = await this.store.revokeMachine(
      machineId,
      secretHash(credential),
      this.now().toISOString(),
    );
    if (result === "invalid") {
      throw new MachineConnectionError(
        "Machine credential is invalid.",
        "invalid_credential",
      );
    }
    await this.onMachineRevoked(machineId);
    return { machineId, status: "revoked" as const };
  }

  async authenticateMachine(
    machineId: string,
    credential: string,
    allowRevoked = false,
  ) {
    const machine = machineId ? await this.store.getMachine(machineId) : null;
    const suppliedCredential = typeof credential === "string" ? credential : "";
    const credentialMatches = equalSecretHash(
      machine?.credentialHash ?? invalidCredentialHash,
      suppliedCredential,
    );
    if (!machine || !suppliedCredential || !credentialMatches) {
      throw new MachineConnectionError(
        "Machine credential is invalid.",
        "invalid_credential",
      );
    }
    if (machine.revokedAt && !allowRevoked) {
      throw new MachineConnectionError("Machine was revoked.", "revoked");
    }
    return machine;
  }

  private async requireRequest(requestId: string) {
    const request = requestId ? await this.store.getRequest(requestId) : null;
    if (!request) {
      throw new MachineConnectionError(
        "Connection request was not found.",
        "not_found",
      );
    }
    return request;
  }

  private async expireIfNeeded(request: MachineConnectRequestRecord) {
    if (
      (request.status === "pending" || request.status === "approved") &&
      Date.parse(request.expiresAt) <= this.now().getTime()
    ) {
      const expired = { ...request, status: "expired" as const };
      if (
        (await this.store.updateRequestIfStatus(expired, request.status)) ===
        "updated"
      ) {
        return expired;
      }
      return (await this.store.getRequest(request.id)) ?? expired;
    }
    return request;
  }
}

export const machineApprovalProofMessage = approvalProofMessage;
