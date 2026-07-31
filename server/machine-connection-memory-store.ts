import { timingSafeEqual } from "node:crypto";

import type {
  MachineConnectionStore,
  MachineConnectPhysicalMachine,
  MachineConnectRequestRecord,
  MachineIdentityRecord,
} from "./machine-connection-contract";

function copyRequest(request: MachineConnectRequestRecord) {
  return structuredClone(request);
}

function copyMachine(machine: MachineIdentityRecord) {
  return structuredClone(machine);
}

function equalHash(expected: string, actual: string) {
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(actual, "hex");
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

export class MemoryMachineConnectionStore implements MachineConnectionStore {
  readonly connectorAssignments = new Map<string, string>();
  readonly machines = new Map<string, MachineIdentityRecord>();
  readonly physicalMachines = new Map<string, MachineConnectPhysicalMachine & { ownerUserId: string }>();
  readonly requests = new Map<string, MachineConnectRequestRecord>();

  addPhysicalMachine(userId: string, machine: MachineConnectPhysicalMachine) {
    this.physicalMachines.set(machine.id, { ...structuredClone(machine), ownerUserId: userId });
  }

  async consumeRequestAndUpsertMachine(
    request: MachineConnectRequestRecord,
    machine: MachineIdentityRecord,
    unexpiredAt: string,
  ) {
    const current = this.requests.get(request.id);
    if (current?.status !== "approved") {
      return { status: "request_unavailable" as const };
    }
    if (Date.parse(current.expiresAt) <= Date.parse(unexpiredAt)) {
      this.requests.set(request.id, {
        ...copyRequest(current),
        status: "expired",
      });
      return { status: "expired" as const };
    }
    const physicalMachine = current.physicalMachineId
      ? this.physicalMachines.get(current.physicalMachineId)
      : undefined;
    if (!physicalMachine || physicalMachine.ownerUserId !== machine.ownerUserId) {
      throw new Error("Connector enrollment requires an owned physical machine.");
    }

    const existing = [...this.machines.values()].find(
      (candidate) => candidate.publicKey === machine.publicKey,
    );
    if (existing && existing.ownerUserId !== machine.ownerUserId) {
      this.requests.set(request.id, copyRequest(request));
      return { status: "key_conflict" as const };
    }

    const persisted = existing
      ? {
          ...copyMachine(existing),
          architecture: machine.architecture,
          clientVersion: machine.clientVersion,
          credentialHash: machine.credentialHash,
          hostname: machine.hostname,
          lastSeenAt: undefined,
          name: machine.name,
          operatingSystem: machine.operatingSystem,
          revokedAt: undefined,
        }
      : copyMachine(machine);
    if (!existing && this.machines.has(persisted.id)) {
      return { status: "request_unavailable" as const };
    }
    this.machines.set(persisted.id, persisted);
    this.connectorAssignments.set(persisted.id, physicalMachine.id);
    this.requests.set(request.id, copyRequest(request));
    return {
      machine: copyMachine(persisted),
      status: existing ? ("rotated" as const) : ("created" as const),
    };
  }

  async createRequest(request: MachineConnectRequestRecord) {
    if (this.requests.has(request.id)) {
      throw new Error("Connection request already exists.");
    }
    this.requests.set(request.id, copyRequest(request));
  }

  async getMachine(id: string) {
    const machine = this.machines.get(id);
    return machine ? copyMachine(machine) : null;
  }

  async getRequest(id: string) {
    const request = this.requests.get(id);
    return request ? copyRequest(request) : null;
  }

  async listPhysicalMachines(userId: string) {
    return [...this.physicalMachines.values()]
      .filter((machine) => machine.ownerUserId === userId)
      .map(({ id, kind, name }) => ({ id, kind, name }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async markMachineOnline(
    machineId: string,
    credentialHash: string,
    lastSeenAt: string,
  ) {
    const current = this.machines.get(machineId);
    if (!current || !equalHash(current.credentialHash, credentialHash)) {
      return "invalid" as const;
    }
    if (current.revokedAt) {
      return "revoked" as const;
    }
    this.machines.set(machineId, { ...copyMachine(current), lastSeenAt });
    return "updated" as const;
  }

  async revokeMachine(
    machineId: string,
    credentialHash: string,
    revokedAt: string,
  ) {
    const current = this.machines.get(machineId);
    if (!current || !equalHash(current.credentialHash, credentialHash)) {
      return "invalid" as const;
    }
    if (current.revokedAt) {
      return "revoked" as const;
    }
    this.machines.set(machineId, { ...copyMachine(current), revokedAt });
    return "updated" as const;
  }

  async updateRequestIfStatus(
    request: MachineConnectRequestRecord,
    expectedStatus: MachineConnectRequestRecord["status"],
    unexpiredAt?: string,
  ) {
    const current = this.requests.get(request.id);
    if (
      current?.status !== expectedStatus
    ) {
      return "status_mismatch" as const;
    }
    if (
      unexpiredAt !== undefined &&
      Date.parse(current.expiresAt) <= Date.parse(unexpiredAt)
    ) {
      this.requests.set(request.id, {
        ...copyRequest(current),
        status: "expired",
      });
      return "expired" as const;
    }
    this.requests.set(request.id, copyRequest(request));
    return "updated" as const;
  }
}
