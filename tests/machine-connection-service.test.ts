import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { MemoryMachineConnectionStore } from "../server/machine-connection-memory-store";
import {
  MachineConnectionError,
  MachineConnectionService,
  machineApprovalProofMessage,
} from "../server/machine-connection-service";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x) {
    throw new Error("Ed25519 key export did not include x.");
  }
  return { privateKey, publicKey: jwk.x };
}

function setup(options: { onMachineRevoked?(machineId: string): void | Promise<void> } = {}) {
  let now = new Date("2026-07-11T10:00:00.000Z");
  const onlineMachines = new Map<string, string>();
  const store = new MemoryMachineConnectionStore();
  const service = new MachineConnectionService({
    isMachineOnline: (machineId, credential) =>
      onlineMachines.get(machineId) === credential,
    now: () => now,
    onMachineRevoked: options.onMachineRevoked,
    publicOrigin: "https://projects.os-home.net",
    requestLifetimeMs: 600_000,
    store,
  });
  return {
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
    service,
    setOnline(machineId: string, credential?: string) {
      if (credential) onlineMachines.set(machineId, credential);
      else onlineMachines.delete(machineId);
    },
    store,
  };
}

function metadata(publicKey: string) {
  return {
    architecture: "amd64" as const,
    clientVersion: "0.3.0",
    hostname: "os-pc",
    name: "os-pc-wsl",
    operatingSystem: "linux" as const,
    publicKey,
  };
}

async function approvedConnection(context = setup()) {
  const keys = keyPair();
  const created = await context.service.createRequest(metadata(keys.publicKey));
  await context.service.approveRequest(created.requestId, "user_oli");
  const approved = await context.service.pollRequest(
    created.requestId,
    created.pollToken,
  );
  if (approved.status !== "approved") {
    throw new Error("Expected approved request.");
  }
  const signature = sign(
    null,
    machineApprovalProofMessage(created.requestId, approved.approvalChallenge),
    keys.privateKey,
  ).toString("base64url");
  return { ...context, approved, created, keys, signature };
}

async function connectWithKey(
  service: MachineConnectionService,
  keys: ReturnType<typeof keyPair>,
  userId: string,
  clientVersion = "0.3.0",
) {
  const created = await service.createRequest({
    ...metadata(keys.publicKey),
    clientVersion,
  });
  await service.approveRequest(created.requestId, userId);
  const approved = await service.pollRequest(
    created.requestId,
    created.pollToken,
  );
  if (approved.status !== "approved") {
    throw new Error("Expected approved request.");
  }
  const signature = sign(
    null,
    machineApprovalProofMessage(created.requestId, approved.approvalChallenge),
    keys.privateKey,
  ).toString("base64url");
  return service.exchangeApproval(
    created.requestId,
    created.pollToken,
    signature,
  );
}

describe("machine connection state machine", () => {
  test("accepts a Portless localhost public origin for local development", async () => {
    const service = new MachineConnectionService({
      publicOrigin: "http://project-space.localhost:1355",
      store: new MemoryMachineConnectionStore(),
    });
    const keys = keyPair();

    const created = await service.createRequest(metadata(keys.publicKey));

    expect(created.approvalUrl).toStartWith(
      "http://project-space.localhost:1355/connector/connect?request=",
    );
  });

  test("requires backend approval and machine-key proof before issuing a credential", async () => {
    const { service, created, signature } = await approvedConnection();
    const exchanged = await service.exchangeApproval(
      created.requestId,
      created.pollToken,
      signature,
    );

    expect(exchanged.machineName).toBe("os-pc-wsl");
    expect(exchanged.credential.length).toBeGreaterThan(32);
    expect(
      await service.getConnectionStatus(
        exchanged.machineId,
        exchanged.credential,
      ),
    ).toEqual({
      lastSeenAt: undefined,
      machineId: exchanged.machineId,
      machineName: "os-pc-wsl",
      status: "offline",
    });
  });

  test("does not reveal request state without the private polling token", async () => {
    const { service, created } = await approvedConnection();
    expect(
      service.pollRequest(created.requestId, "wrong-token"),
    ).rejects.toMatchObject({
      code: "not_found",
    } satisfies Partial<MachineConnectionError>);
  });

  test("rejects a signature from a different machine key", async () => {
    const { service, created, approved } = await approvedConnection();
    const attacker = keyPair();
    const signature = sign(
      null,
      machineApprovalProofMessage(
        created.requestId,
        approved.approvalChallenge,
      ),
      attacker.privateKey,
    ).toString("base64url");

    expect(
      service.exchangeApproval(created.requestId, created.pollToken, signature),
    ).rejects.toMatchObject({
      code: "invalid_proof",
    } satisfies Partial<MachineConnectionError>);
  });

  test("expires pending requests and never allows later approval", async () => {
    const { advance, service } = setup();
    const keys = keyPair();
    const created = await service.createRequest(metadata(keys.publicKey));
    advance(600_001);

    expect(
      await service.pollRequest(created.requestId, created.pollToken),
    ).toMatchObject({
      status: "expired",
    });
    expect(
      service.approveRequest(created.requestId, "user_oli"),
    ).rejects.toMatchObject({
      code: "expired",
    } satisfies Partial<MachineConnectionError>);
  });

  test("rejects approval when expiry is crossed inside the atomic decision", async () => {
    const startedAt = new Date("2026-07-11T10:00:00.000Z");
    const times = [
      startedAt,
      new Date(startedAt.getTime() + 599_999),
      new Date(startedAt.getTime() + 600_001),
    ];
    const store = new MemoryMachineConnectionStore();
    const service = new MachineConnectionService({
      now: () => times.shift() ?? times.at(-1) ?? startedAt,
      publicOrigin: "https://projects.os-home.net",
      requestLifetimeMs: 600_000,
      store,
    });
    const keys = keyPair();
    const created = await service.createRequest(metadata(keys.publicKey));

    expect(
      service.approveRequest(created.requestId, "user_oli"),
    ).rejects.toMatchObject({
      code: "expired",
    } satisfies Partial<MachineConnectionError>);
    expect(store.requests.get(created.requestId)?.status).toBe("expired");
  });

  test("consumes approval exactly once", async () => {
    const { service, created, signature } = await approvedConnection();
    await service.exchangeApproval(
      created.requestId,
      created.pollToken,
      signature,
    );

    expect(
      service.exchangeApproval(created.requestId, created.pollToken, signature),
    ).rejects.toMatchObject({
      code: "already_used",
    } satisfies Partial<MachineConnectionError>);
  });

  test("allows only one winner when two exchanges race", async () => {
    const { service, created, signature, store } = await approvedConnection();
    const results = await Promise.allSettled([
      service.exchangeApproval(created.requestId, created.pollToken, signature),
      service.exchangeApproval(created.requestId, created.pollToken, signature),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(store.machines.size).toBe(1);
  });

  test("rotates credentials onto the same machine identity for the same key owner", async () => {
    const { service, store } = setup();
    const keys = keyPair();

    const first = await connectWithKey(service, keys, "user_oli");
    expect(store.machines.get(first.machineId)?.clientVersion).toBe("0.3.0");

    const second = await connectWithKey(service, keys, "user_oli", "0.4.0");

    expect(second.machineId).toBe(first.machineId);
    expect(second.credential).not.toBe(first.credential);
    expect(store.machines.size).toBe(1);
    expect(store.machines.get(first.machineId)?.clientVersion).toBe("0.4.0");
    expect(
      service.getConnectionStatus(first.machineId, first.credential),
    ).rejects.toMatchObject({
      code: "invalid_credential",
    } satisfies Partial<MachineConnectionError>);
  });

  test("never transfers an existing machine key to another user", async () => {
    const { service, store } = setup();
    const keys = keyPair();
    await connectWithKey(service, keys, "user_oli");

    expect(connectWithKey(service, keys, "user_other")).rejects.toMatchObject({
      code: "invalid_proof",
    } satisfies Partial<MachineConnectionError>);
    expect(store.machines.size).toBe(1);
    expect([...store.machines.values()][0]?.ownerUserId).toBe("user_oli");
  });

  test("uses the live connector channel as online evidence and rejects a revoked machine", async () => {
    const { service, setOnline, created, signature } =
      await approvedConnection();
    const machine = await service.exchangeApproval(
      created.requestId,
      created.pollToken,
      signature,
    );
    await service.markMachineOnline(machine.machineId, machine.credential);

    expect(
      await service.getConnectionStatus(machine.machineId, machine.credential),
    ).toMatchObject({
      status: "offline",
    });
    setOnline(machine.machineId, machine.credential);
    expect(
      await service.getConnectionStatus(machine.machineId, machine.credential),
    ).toMatchObject({
      status: "online",
    });
    setOnline(machine.machineId);
    expect(
      await service.getConnectionStatus(machine.machineId, machine.credential),
    ).toMatchObject({
      status: "offline",
    });

    await service.revokeMachine(machine.machineId, machine.credential);
    expect(
      await service.getConnectionStatus(machine.machineId, machine.credential),
    ).toMatchObject({
      status: "revoked",
    });
    expect(
      service.markMachineOnline(machine.machineId, machine.credential),
    ).rejects.toMatchObject({
      code: "revoked",
    } satisfies Partial<MachineConnectionError>);
  });

  test("never loses revocation when a heartbeat races it", async () => {
    const { service, store, created, signature } = await approvedConnection();
    const machine = await service.exchangeApproval(
      created.requestId,
      created.pollToken,
      signature,
    );

    await Promise.allSettled([
      service.markMachineOnline(machine.machineId, machine.credential),
      service.revokeMachine(machine.machineId, machine.credential),
    ]);

    expect(store.machines.get(machine.machineId)?.revokedAt).toBeDefined();
    expect(
      await service.getConnectionStatus(machine.machineId, machine.credential),
    ).toMatchObject({
      status: "revoked",
    });
    expect(
      service.markMachineOnline(machine.machineId, machine.credential),
    ).rejects.toMatchObject({
      code: "revoked",
    } satisfies Partial<MachineConnectionError>);
  });

  test("keeps revocation idempotent for the owning machine credential", async () => {
    const { advance, service, store, created, signature } =
      await approvedConnection();
    const machine = await service.exchangeApproval(
      created.requestId,
      created.pollToken,
      signature,
    );

    await service.revokeMachine(machine.machineId, machine.credential);
    const firstRevokedAt = store.machines.get(machine.machineId)?.revokedAt;
    advance(60_000);
    await expect(
      service.revokeMachine(machine.machineId, machine.credential),
    ).resolves.toEqual({
      machineId: machine.machineId,
      status: "revoked",
    });
    expect(store.machines.get(machine.machineId)?.revokedAt).toBe(
      firstRevokedAt,
    );
  });

  test("evicts the live machine channel immediately after durable revocation", async () => {
    const evicted: string[] = [];
    const { service, created, signature } = await approvedConnection(
      setup({ onMachineRevoked: (machineId) => evicted.push(machineId) }),
    );
    const machine = await service.exchangeApproval(
      created.requestId,
      created.pollToken,
      signature,
    );

    await service.revokeMachine(machine.machineId, machine.credential);

    expect(evicted).toEqual([machine.machineId]);
  });

  test("does not mutate machine activity for an invalid credential", async () => {
    const { service, store, created, signature } = await approvedConnection();
    const machine = await service.exchangeApproval(
      created.requestId,
      created.pollToken,
      signature,
    );
    const before = structuredClone(store.machines.get(machine.machineId));

    await Promise.allSettled([
      service.markMachineOnline(machine.machineId, "wrong-credential"),
      service.revokeMachine(machine.machineId, "wrong-credential"),
    ]);

    expect(store.machines.get(machine.machineId)).toEqual(before);
  });

  test("validates machine identity metadata before persisting it", async () => {
    const { service, store } = setup();
    const keys = keyPair();

    expect(
      service.createRequest({
        ...metadata(keys.publicKey),
        name: "../not-a-machine",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    } satisfies Partial<MachineConnectionError>);
    expect(store.requests.size).toBe(0);
  });

  test("accepts a human-readable machine name while keeping hostname strict", async () => {
    const { service, store } = setup();
    const keys = keyPair();
    const created = await service.createRequest({
      ...metadata(keys.publicKey),
      name: "Office PC",
    });

    expect(created.requestId).toBeTruthy();
    expect(store.requests.get(created.requestId)?.name).toBe("Office PC");
    expect(
      service.createRequest({
        ...metadata(keys.publicKey),
        hostname: "office pc",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
