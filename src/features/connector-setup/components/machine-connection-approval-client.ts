export type ApprovalStatus =
  "approved" | "consumed" | "denied" | "expired" | "pending";
export type MachineConnectionDecision = "approve" | "deny";

export interface MachineConnectionApproval {
  architecture: "amd64" | "arm64";
  clientVersion: string;
  expiresAt: string;
  hostname: string;
  name: string;
  operatingSystem: "darwin" | "linux" | "windows";
  status: ApprovalStatus;
}

const approvalStatuses = new Set<ApprovalStatus>([
  "approved",
  "consumed",
  "denied",
  "expired",
  "pending",
]);
const architectures = new Set<MachineConnectionApproval["architecture"]>([
  "amd64",
  "arm64",
]);
const operatingSystems = new Set<MachineConnectionApproval["operatingSystem"]>([
  "darwin",
  "linux",
  "windows",
]);
const machineNamePattern = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const hostnamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const maximumErrorMessageLength = 500;

export class MachineConnectionResponseError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "MachineConnectionResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringMatching(value: unknown, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function invalidPayload(message: string): never {
  throw new MachineConnectionResponseError(message);
}

export function parseMachineConnectionApproval(
  payload: unknown,
): MachineConnectionApproval {
  if (!isRecord(payload)) {
    return invalidPayload(
      "Project Space returned an invalid machine approval response.",
    );
  }

  const architecture = payload.architecture;
  const clientVersion = stringMatching(payload.clientVersion, versionPattern);
  const expiresAt = payload.expiresAt;
  const hostname = stringMatching(payload.hostname, hostnamePattern);
  const name = stringMatching(payload.name, machineNamePattern);
  const operatingSystem = payload.operatingSystem;
  const status = payload.status;

  if (
    !architectures.has(
      architecture as MachineConnectionApproval["architecture"],
    ) ||
    !clientVersion ||
    !isIsoTimestamp(expiresAt) ||
    !hostname ||
    !name ||
    !operatingSystems.has(
      operatingSystem as MachineConnectionApproval["operatingSystem"],
    ) ||
    !approvalStatuses.has(status as ApprovalStatus)
  ) {
    return invalidPayload(
      "Project Space returned an invalid machine approval response.",
    );
  }

  return {
    architecture: architecture as MachineConnectionApproval["architecture"],
    clientVersion,
    expiresAt,
    hostname,
    name,
    operatingSystem:
      operatingSystem as MachineConnectionApproval["operatingSystem"],
    status: status as ApprovalStatus,
  };
}

export function parseMachineConnectionDecision(
  payload: unknown,
  decision: MachineConnectionDecision,
) {
  const expectedStatus = decision === "approve" ? "approved" : "denied";
  if (!isRecord(payload) || payload.status !== expectedStatus) {
    return invalidPayload(
      "Project Space returned an invalid machine decision response.",
    );
  }
  return { status: expectedStatus } as const;
}

function responseError(payload: unknown, fallback: string, statusCode: number) {
  if (!isRecord(payload)) {
    return new MachineConnectionResponseError(fallback, statusCode);
  }

  const message =
    typeof payload.error === "string" &&
    payload.error.trim() &&
    payload.error.length <= maximumErrorMessageLength
      ? payload.error.trim()
      : fallback;
  const code =
    typeof payload.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(payload.code)
      ? payload.code
      : undefined;
  return new MachineConnectionResponseError(message, statusCode, code);
}

async function readResponsePayload(response: Response) {
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new MachineConnectionResponseError(
      "Could not read the machine connection response.",
      response.status,
    );
  }

  if (!body.trim()) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

export async function readMachineConnectionResponse<Result>(
  response: Response,
  parse: (payload: unknown) => Result,
  fallback: string,
) {
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw responseError(payload, fallback, response.status);
  }
  return parse(payload);
}

export function isAuthenticationError(error: unknown) {
  return (
    error instanceof MachineConnectionResponseError && error.statusCode === 401
  );
}

export function shouldRefreshAfterDecisionError(error: unknown) {
  return (
    error instanceof MachineConnectionResponseError && error.statusCode === 409
  );
}
