export const hostControlSchemaVersion = 1;

export type HostControlRisk = 'standard' | 'boot' | 'disk' | 'firmware' |
  'installer' | 'recovery' | 'secure_boot';
export type HostPowerState = 'on' | 'off' | 'unknown';

export interface HostControlSelector {
  host: string;
}

export interface HostCapabilityRecord {
  available: boolean;
  hostId: string;
  lastVerifiedAt?: string;
  power: Array<'status' | 'on' | 'off'>;
  provider: { id: string; kind: 'jetkvm' };
  console: Array<'screenshot' | 'key' | 'chord' | 'text' | 'mouse_move' | 'mouse_click'>;
  schemaVersion: typeof hostControlSchemaVersion;
}

export interface HostControlStatus extends HostCapabilityRecord {
  powerState: HostPowerState;
}

export interface HostConsoleFrame {
  capturedAt: string;
  frameId: string;
  height: number;
  png: Uint8Array;
  staleAfter: string;
  width: number;
}

export type HostConsoleInput =
  | { kind: 'key'; key: string }
  | { kind: 'chord'; keys: string[] }
  | { kind: 'text'; text: string }
  | { frameId: string; kind: 'mouse_move'; x: number; y: number }
  | { button: 'left' | 'middle' | 'right'; frameId: string; kind: 'mouse_click'; x: number; y: number };

export interface HostControlOperationRequest {
  approvalId?: string;
  input?: HostConsoleInput;
  operationId: string;
  powerState?: 'on' | 'off';
  risk: HostControlRisk;
}

export interface HostControlOperationResult {
  auditId: string;
  code?: 'operation_in_progress' | 'provider_unavailable' | 'stale_frame' | 'unauthorized';
  completedAt: string;
  hostId: string;
  operationId: string;
  provider: { id: string; kind: 'jetkvm' };
  replayed: boolean;
  schemaVersion: typeof hostControlSchemaVersion;
  message: string;
  state: 'completed' | 'failed' | 'rejected' | 'uncertain';
}
