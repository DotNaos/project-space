import { createHash } from "node:crypto";

import type { DatabaseQueryClient } from "../server/database/client";
import type {
  MachineConnectRequestRecord,
  MachineIdentityRecord,
} from "../server/machine-connection-contract";

export interface QueryCall {
  sql: string;
  values: readonly unknown[];
}

export type QueryHandler = (
  sql: string,
  values: readonly unknown[],
) => unknown[] | Promise<unknown[]>;

export class ScriptedQueryClient implements DatabaseQueryClient {
  readonly calls: QueryCall[] = [];

  constructor(private readonly handler: QueryHandler) {}

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: (await this.handler(sql, values)) as Row[] };
  }

  async transaction<Result>(
    operation: (client: DatabaseQueryClient) => Promise<Result>,
  ) {
    await this.query("begin");
    try {
      const result = await operation(this);
      await this.query("commit");
      return result;
    } catch (error) {
      await this.query("rollback");
      throw error;
    }
  }
}

export const requestId = "11111111-1111-4111-8111-111111111111";
export const newMachineId = "22222222-2222-4222-8222-222222222222";
export const stableMachineId = "33333333-3333-4333-8333-333333333333";
export const membershipId = "44444444-4444-4444-8444-444444444444";
export const credentialId = "55555555-5555-4555-8555-555555555555";
export const oldCredentialId = "66666666-6666-4666-8666-666666666666";
export const publicKey = Buffer.alloc(32, 9).toString("base64url");
export const pollToken = Buffer.alloc(32, 7).toString("base64url");
export const credential = Buffer.alloc(32, 8).toString("base64url");
export const oldCredential = Buffer.alloc(32, 6).toString("base64url");
export const pollTokenHash = createHash("sha256")
  .update(pollToken, "utf8")
  .digest("hex");
export const credentialHash = createHash("sha256")
  .update(credential, "utf8")
  .digest("hex");
export const oldCredentialHash = createHash("sha256")
  .update(oldCredential, "utf8")
  .digest("hex");
export const createdAt = "2026-07-11T01:00:00.000Z";
export const expiresAt = "2026-07-11T01:10:00.000Z";
export const consumedAt = "2026-07-11T01:05:00.000Z";

export function approvedRequest(
  overrides: Partial<MachineConnectRequestRecord> = {},
): MachineConnectRequestRecord {
  return {
    approvalChallenge: "approval-challenge",
    approvedAt: "2026-07-11T01:01:00.000Z",
    approvedByUserId: "user-a",
    architecture: "amd64",
    clientVersion: "0.2.0",
    createdAt,
    expiresAt,
    hostname: "os-pc",
    id: requestId,
    name: "OS PC",
    operatingSystem: "linux",
    pollTokenHash,
    publicKey,
    status: "approved",
    ...overrides,
  };
}

export function consumedRequest(
  overrides: Partial<MachineConnectRequestRecord> = {},
) {
  return approvedRequest({ consumedAt, status: "consumed", ...overrides });
}

export function machine(
  overrides: Partial<MachineIdentityRecord> = {},
): MachineIdentityRecord {
  return {
    architecture: "amd64",
    clientVersion: "0.2.0",
    createdAt: consumedAt,
    credentialHash,
    hostname: "os-pc",
    id: newMachineId,
    name: "OS PC",
    operatingSystem: "linux",
    ownerUserId: "user-a",
    publicKey,
    ...overrides,
  };
}

export function requestRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const request = approvedRequest();
  return {
    approval_challenge: request.approvalChallenge,
    approved_at: request.approvedAt,
    approved_by_user_id: request.approvedByUserId,
    architecture: request.architecture,
    client_version: request.clientVersion,
    consumed_at: null,
    created_at: new Date(request.createdAt),
    denied_at: null,
    expires_at: new Date(request.expiresAt),
    hostname: request.hostname,
    id: request.id,
    name: request.name,
    operating_system: request.operatingSystem,
    poll_token_hash: request.pollTokenHash,
    public_key: request.publicKey,
    status: request.status,
    ...overrides,
  };
}

export function identityRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const value = machine();
  return {
    architecture: value.architecture,
    client_version: value.clientVersion,
    created_at: new Date(value.createdAt),
    current_credential_id: oldCredentialId,
    hostname: value.hostname,
    id: value.id,
    last_seen_at: null,
    name: value.name,
    operating_system: value.operatingSystem,
    owner_user_id: value.ownerUserId,
    public_key: value.publicKey,
    revoked_at: null,
    ...overrides,
  };
}

export function callIndex(client: ScriptedQueryClient, fragment: string) {
  return client.calls.findIndex((call) => call.sql.includes(fragment));
}
