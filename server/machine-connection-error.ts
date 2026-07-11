export type MachineConnectionErrorCode =
  | "already_decided"
  | "already_used"
  | "denied"
  | "expired"
  | "invalid_credential"
  | "invalid_input"
  | "invalid_proof"
  | "not_found"
  | "pending"
  | "revoked";

export class MachineConnectionError extends Error {
  constructor(
    message: string,
    readonly code: MachineConnectionErrorCode,
  ) {
    super(message);
    this.name = "MachineConnectionError";
  }
}
