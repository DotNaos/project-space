import { describe, expect, test } from "bun:test";

import { DatabaseMachineConnectionStore } from "../server/machine-connection-database-store";
import {
  approvedRequest,
  callIndex,
  consumedAt,
  consumedRequest,
  createdAt,
  credential,
  credentialHash,
  credentialId,
  expiresAt,
  identityRow,
  machine,
  membershipId,
  newMachineId,
  oldCredentialId,
  oldCredentialHash,
  pollToken,
  publicKey,
  requestId,
  requestRow,
  ScriptedQueryClient,
  stableMachineId,
} from "./machine-connection-database-fixture";

function storeWithIds(
  client: ScriptedQueryClient | Promise<ScriptedQueryClient>,
  ttl = 31_536_000,
) {
  const ids = [membershipId, credentialId];
  return new DatabaseMachineConnectionStore(client, {
    createId: () => ids.shift() ?? credentialId,
    credentialTtlSeconds: ttl,
  });
}

describe("database machine connection store", () => {
  test("rejects a query client that cannot guarantee a single-connection transaction", async () => {
    let queried = false;
    const store = new DatabaseMachineConnectionStore({
      async query() {
        queried = true;
        return { rows: [] };
      },
    } as never);

    await expect(store.createRequest(approvedRequest())).rejects.toThrow(
      "Machine connection database client must support transactions.",
    );
    expect(queried).toBe(false);
  });

  test("persists only request hashes and maps a complete request from an async client", async () => {
    const client = new ScriptedQueryClient((sql) =>
      sql.includes("from machine_connection_requests") ? [requestRow()] : [],
    );
    const store = storeWithIds(Promise.resolve(client));
    const request = approvedRequest();

    await store.createRequest(request);
    await expect(store.getRequest(requestId)).resolves.toEqual(request);

    const insert = client.calls[0];
    expect(insert?.sql).toContain("insert into machine_connection_requests");
    expect(insert?.values).toContain(request.pollTokenHash);
    expect(JSON.stringify(client.calls)).not.toContain(pollToken);
    expect(insert?.sql).not.toContain(request.pollTokenHash);
  });

  test("cleans expired requests in one bounded skip-locked batch", async () => {
    const database = new ScriptedQueryClient((sql) => {
      if (sql.includes("with expired_requests as")) {
        return Array.from({ length: 3 }, () => ({ removed: 1 }));
      }
      return [];
    });
    const store = new DatabaseMachineConnectionStore(database);

    await expect(store.cleanupOldRequests()).resolves.toBe(3);
    const cleanup = database.calls.find((call) =>
      call.sql.includes("with expired_requests as"),
    );
    expect(cleanup?.sql).toContain("now() - interval '24 hours'");
    expect(cleanup?.sql).toContain("for update skip locked");
    expect(cleanup?.values).toEqual([500]);
  });

  test("locks, creates, enrolls, rotates credentials, and consumes in one ordered transaction", async () => {
    const client = new ScriptedQueryClient((sql) => {
      if (sql.includes("from machine_connection_requests") && sql.includes("for update")) {
        return [requestRow()];
      }
      if (sql.includes("set status = 'expired'")) return [];
      if (sql.includes("from machine_identities") && sql.includes("public_key")) return [];
      if (sql.includes("insert into machine_identities")) {
        return [identityRow({ current_credential_id: null })];
      }
      if (sql.includes("insert into connector_credentials")) return [{ id: credentialId }];
      if (sql.includes("set current_credential_id")) return [{ id: newMachineId }];
      if (sql.includes("set status = 'consumed'")) return [{ id: requestId }];
      return [];
    });
    const store = storeWithIds(client, 86_400);

    await expect(
      store.consumeRequestAndUpsertMachine(
        consumedRequest(),
        machine(),
        consumedAt,
      ),
    ).resolves.toEqual({ machine: machine(), status: "created" });

    const orderedFragments = [
      "begin",
      "from machine_connection_requests",
      "set status = 'expired'",
      "pg_advisory_xact_lock",
      "from machine_identities",
      "insert into machine_identities",
      "insert into machine_memberships",
      "update connector_credentials",
      "insert into connector_credentials",
      "set current_credential_id",
      "set status = 'consumed'",
      "commit",
    ];
    const indexes = orderedFragments.map((fragment) => callIndex(client, fragment));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));

    const credentialInsert = client.calls.find((call) =>
      call.sql.includes("insert into connector_credentials"),
    );
    expect(credentialInsert?.values).toEqual([
      credentialId,
      "user-a",
      credentialHash,
      newMachineId,
      consumedAt,
      86_400,
    ]);
    expect(credentialInsert?.sql).toContain("expected_machine_id, machine_id");
    expect(JSON.stringify(client.calls)).not.toContain(credential);
    const currentCredentialUpdate = client.calls.find((call) =>
      call.sql.includes("set current_credential_id"),
    );
    expect(currentCredentialUpdate?.values).toEqual([
      newMachineId,
      credentialId,
      "user-a",
      publicKey,
    ]);
  });

  test("rotates onto the stable public-key identity and revokes its previous credential", async () => {
    const oldCreatedAt = "2026-06-01T01:00:00.000Z";
    const existing = identityRow({
      created_at: oldCreatedAt,
      id: stableMachineId,
      last_seen_at: "2026-07-10T01:00:00.000Z",
      revoked_at: "2026-07-10T02:00:00.000Z",
    });
    const rotated = identityRow({ created_at: oldCreatedAt, id: stableMachineId });
    const client = new ScriptedQueryClient((sql) => {
      if (sql.includes("from machine_connection_requests") && sql.includes("for update")) {
        return [requestRow()];
      }
      if (sql.includes("set status = 'expired'")) return [];
      if (sql.includes("from machine_identities") && sql.includes("public_key")) {
        return [existing];
      }
      if (sql.includes("update machine_identities") && sql.includes("client_version")) {
        return [rotated];
      }
      if (sql.includes("insert into connector_credentials")) return [{ id: credentialId }];
      if (sql.includes("set current_credential_id")) return [{ id: stableMachineId }];
      if (sql.includes("set status = 'consumed'")) return [{ id: requestId }];
      return [];
    });
    const store = storeWithIds(client);

    const result = await store.consumeRequestAndUpsertMachine(
      consumedRequest(),
      machine(),
      consumedAt,
    );

    expect(result.status).toBe("rotated");
    if (result.status === "rotated") {
      expect(result.machine.id).toBe(stableMachineId);
      expect(result.machine.createdAt).toBe(oldCreatedAt);
      expect(result.machine.revokedAt).toBeUndefined();
    }
    const membership = client.calls.find((call) =>
      call.sql.includes("insert into machine_memberships"),
    );
    expect(membership?.values).toEqual([
      membershipId,
      stableMachineId,
      "user-a",
      consumedAt,
    ]);
    const revocation = client.calls.find((call) =>
      call.sql.includes("update connector_credentials"),
    );
    expect(revocation?.sql).toContain("machine_id = $1");
    expect(revocation?.values).toEqual([stableMachineId, consumedAt]);
    const insertion = client.calls.find((call) =>
      call.sql.includes("insert into connector_credentials"),
    );
    expect(insertion?.values[3]).toBe(stableMachineId);
    const currentCredentialUpdate = client.calls.find((call) =>
      call.sql.includes("set current_credential_id"),
    );
    expect(currentCredentialUpdate?.values).toEqual([
      stableMachineId,
      credentialId,
      "user-a",
      publicKey,
    ]);
  });

  test("keeps the new credential current with equal or inverted rotation timestamps", async () => {
    for (const rotationAt of [
      consumedAt,
      "2026-07-11T01:04:00.000Z",
    ]) {
      let currentCredentialId = oldCredentialId;
      const existing = identityRow({
        created_at: "2026-06-01T01:00:00.000Z",
        current_credential_id: oldCredentialId,
        id: stableMachineId,
      });
      const client = new ScriptedQueryClient((sql, values) => {
        if (sql.includes("from machine_connection_requests") && sql.includes("for update")) {
          return [requestRow()];
        }
        if (sql.includes("set status = 'expired'")) return [];
        if (sql.includes("from machine_identities mi")) {
          expect(currentCredentialId).toBe(credentialId);
          return [{
            ...existing,
            credential_expires_at: expiresAt,
            credential_hash: credentialHash,
            current_credential_id: currentCredentialId,
            effective_revoked_at: null,
          }];
        }
        if (sql.includes("from machine_identities") && sql.includes("public_key")) {
          return [existing];
        }
        if (sql.includes("update machine_identities") && sql.includes("client_version")) {
          return [{ ...existing, current_credential_id: currentCredentialId }];
        }
        if (sql.includes("set revoked_at = coalesce")) return [];
        if (sql.includes("insert into connector_credentials")) return [{ id: credentialId }];
        if (sql.includes("set current_credential_id")) {
          expect(values).toEqual([
            stableMachineId,
            credentialId,
            "user-a",
            publicKey,
          ]);
          currentCredentialId = credentialId;
          return [{ id: stableMachineId }];
        }
        if (sql.includes("set status = 'consumed'")) return [{ id: requestId }];
        if (sql.includes("from machine_identities") && sql.includes("for update")) {
          return [{ current_credential_id: currentCredentialId, revoked_at: null }];
        }
        if (sql.includes("from connector_credentials") && sql.includes("for update")) {
          return [{
            credential_expired: false,
            credential_id: currentCredentialId,
            credential_matches: values[2] === credentialHash,
            credential_revoked_at: null,
          }];
        }
        if (sql.includes("update connector_credentials")) return [{ id: credentialId }];
        if (sql.includes("update machine_identities")) return [{ id: stableMachineId }];
        return [];
      });
      const store = storeWithIds(client);
      const rotatedRequest = consumedRequest({ consumedAt: rotationAt });
      const rotatedMachine = machine({ createdAt: rotationAt });

      await expect(
        store.consumeRequestAndUpsertMachine(
          rotatedRequest,
          rotatedMachine,
          rotationAt,
        ),
      ).resolves.toMatchObject({ status: "rotated" });
      await expect(store.getMachine(stableMachineId)).resolves.toMatchObject({
        credentialHash,
        id: stableMachineId,
      });
      await expect(
        store.markMachineOnline(stableMachineId, credentialHash, consumedAt),
      ).resolves.toBe("updated");
      await expect(
        store.revokeMachine(stableMachineId, oldCredentialHash, consumedAt),
      ).resolves.toBe("invalid");

      const credentialReads = client.calls.filter((call) =>
        call.sql.includes("from connector_credentials"),
      );
      expect(credentialReads.every((call) => !call.sql.includes("order by"))).toBe(true);
      expect(credentialReads.every((call) => call.values[1] === credentialId)).toBe(true);
    }
  });

  test("consumes an owner-conflicting request without changing machine credentials", async () => {
    const client = new ScriptedQueryClient((sql) => {
      if (sql.includes("from machine_connection_requests") && sql.includes("for update")) {
        return [requestRow()];
      }
      if (sql.includes("set status = 'expired'")) return [];
      if (sql.includes("from machine_identities") && sql.includes("public_key")) {
        return [identityRow({ owner_user_id: "user-b" })];
      }
      if (sql.includes("set status = 'consumed'")) return [{ id: requestId }];
      return [];
    });
    const store = storeWithIds(client);

    await expect(
      store.consumeRequestAndUpsertMachine(consumedRequest(), machine(), consumedAt),
    ).resolves.toEqual({ status: "key_conflict" });
    expect(callIndex(client, "set status = 'consumed'")).toBeGreaterThan(-1);
    expect(callIndex(client, "insert into machine_memberships")).toBe(-1);
    expect(callIndex(client, "insert into connector_credentials")).toBe(-1);
    expect(client.calls.at(-1)?.sql).toBe("commit");
  });

  test("expires at the exact boundary before touching an identity", async () => {
    const client = new ScriptedQueryClient((sql, values) => {
      if (sql.includes("from machine_connection_requests") && sql.includes("for update")) {
        return [requestRow()];
      }
      if (sql.includes("set status = 'expired'")) {
        expect(values).toEqual([requestId, expiresAt]);
        return [{ id: requestId }];
      }
      return [];
    });
    const store = storeWithIds(client);

    await expect(
      store.consumeRequestAndUpsertMachine(consumedRequest(), machine(), expiresAt),
    ).resolves.toEqual({ status: "expired" });
    expect(callIndex(client, "expires_at <= $2::timestamptz")).toBeGreaterThan(-1);
    expect(callIndex(client, "from machine_identities")).toBe(-1);
    expect(client.calls.at(-1)?.sql).toBe("commit");
  });

  test("rolls the whole exchange back when direct credential insertion fails", async () => {
    const insertFailure = new Error("credential insert failed");
    const client = new ScriptedQueryClient((sql) => {
      if (sql.includes("from machine_connection_requests") && sql.includes("for update")) {
        return [requestRow()];
      }
      if (sql.includes("set status = 'expired'")) return [];
      if (sql.includes("from machine_identities") && sql.includes("public_key")) return [];
      if (sql.includes("insert into machine_identities")) return [identityRow()];
      if (sql.includes("insert into connector_credentials")) throw insertFailure;
      return [];
    });
    const store = storeWithIds(client);

    await expect(
      store.consumeRequestAndUpsertMachine(consumedRequest(), machine(), consumedAt),
    ).rejects.toBe(insertFailure);
    expect(client.calls.at(-1)?.sql).toBe("rollback");
    expect(callIndex(client, "set status = 'consumed'")).toBe(-1);
  });

  test("applies request decisions atomically and reports an expiry-boundary loss", async () => {
    const client = new ScriptedQueryClient((sql, values) =>
      sql.includes("update machine_connection_requests")
        ? [{ expired_by_boundary: values[8] !== null, status: "expired" }]
        : [],
    );
    const store = storeWithIds(client);
    const approved = approvedRequest();

    await expect(
      store.updateRequestIfStatus(approved, "pending", expiresAt),
    ).resolves.toBe("expired");
    expect(client.calls[0]?.sql).toContain("expires_at <= $9::timestamptz");
    expect(client.calls[0]?.values).toEqual([
      requestId,
      "pending",
      "approved",
      "approval-challenge",
      "2026-07-11T01:01:00.000Z",
      "user-a",
      null,
      null,
      expiresAt,
    ]);
    await expect(
      store.updateRequestIfStatus(
        approvedRequest({ status: "expired" }),
        "approved",
      ),
    ).resolves.toBe("updated");
  });

  test("updates only the explicitly assigned current credential and rejects an older rotation", async () => {
    const client = new ScriptedQueryClient((sql) => {
      if (sql.includes("from machine_identities") && sql.includes("for update")) {
        return [{ current_credential_id: credentialId, revoked_at: null }];
      }
      if (sql.includes("from connector_credentials") && sql.includes("for update")) {
        return [{
          credential_expired: false,
          credential_id: credentialId,
          credential_matches: true,
          credential_revoked_at: null,
        }];
      }
      if (sql.includes("update connector_credentials")) return [{ id: credentialId }];
      if (sql.includes("update machine_identities")) return [{ id: newMachineId }];
      return [];
    });
    const store = storeWithIds(client);

    await expect(
      store.markMachineOnline(newMachineId, credentialHash, consumedAt),
    ).resolves.toBe("updated");
    expect(callIndex(client, "update connector_credentials")).toBeLessThan(
      callIndex(client, "update machine_identities"),
    );
    const update = client.calls.find((call) =>
      call.sql.includes("update connector_credentials"),
    );
    expect(update?.sql).toContain("id = $1 and token_hash = $2");
    expect(update?.values).toEqual([credentialId, credentialHash, consumedAt]);
    const credentialLock = client.calls.find((call) =>
      call.sql.includes("from connector_credentials") && call.sql.includes("for update"),
    );
    expect(credentialLock?.sql).toContain(
      "where id = $2 and machine_id = $1 and expected_machine_id = $1",
    );
    expect(credentialLock?.values).toEqual([
      newMachineId,
      credentialId,
      credentialHash,
      consumedAt,
    ]);

    const oldClient = new ScriptedQueryClient((sql) => {
      if (sql.includes("from machine_identities")) {
        return [{ current_credential_id: credentialId, revoked_at: null }];
      }
      if (sql.includes("from connector_credentials")) {
        return [{
          credential_expired: false,
          credential_id: credentialId,
          credential_matches: false,
          credential_revoked_at: null,
        }];
      }
      return [];
    });
    await expect(
      storeWithIds(oldClient).revokeMachine(newMachineId, credentialHash, consumedAt),
    ).resolves.toBe("invalid");
    expect(callIndex(oldClient, "update connector_credentials")).toBe(-1);
    expect(callIndex(oldClient, "update machine_identities")).toBe(-1);
  });

  test("revokes the current credential idempotently without a second mutation", async () => {
    let revoked = false;
    const client = new ScriptedQueryClient((sql) => {
      if (sql.includes("from machine_identities") && sql.includes("for update")) {
        return [{
          current_credential_id: credentialId,
          revoked_at: revoked ? consumedAt : null,
        }];
      }
      if (sql.includes("from connector_credentials") && sql.includes("for update")) {
        return [{
          credential_expired: false,
          credential_id: credentialId,
          credential_matches: true,
          credential_revoked_at: revoked ? consumedAt : null,
        }];
      }
      if (sql.includes("update connector_credentials")) return [{ id: credentialId }];
      if (sql.includes("update machine_identities")) {
        revoked = true;
        return [{ id: newMachineId }];
      }
      return [];
    });
    const store = storeWithIds(client);

    await expect(
      store.revokeMachine(newMachineId, credentialHash, consumedAt),
    ).resolves.toBe("updated");
    await expect(
      store.revokeMachine(newMachineId, credentialHash, consumedAt),
    ).resolves.toBe("revoked");
    expect(
      client.calls.filter((call) => call.sql.includes("update connector_credentials")),
    ).toHaveLength(1);
    expect(
      client.calls.filter((call) => call.sql.includes("update machine_identities")),
    ).toHaveLength(1);
  });

  test("joins the assigned current credential and rejects malformed database rows", async () => {
    const client = new ScriptedQueryClient((sql) => {
      if (sql.includes("from machine_identities mi")) {
        return [identityRow({
          credential_expires_at: expiresAt,
          credential_hash: credentialHash,
          effective_revoked_at: expiresAt,
        })];
      }
      return [requestRow({ operating_system: "plan9" })];
    });
    const store = storeWithIds(client);

    await expect(store.getMachine(newMachineId)).resolves.toEqual({
      ...machine(),
      revokedAt: expiresAt,
    });
    const machineQuery = client.calls[0]?.sql ?? "";
    expect(machineQuery).toContain("credential.id = mi.current_credential_id");
    expect(machineQuery).not.toContain("order by");
    expect(machineQuery).toContain("credential.expires_at <= now()");
    await expect(store.getRequest(requestId)).rejects.toThrow(
      "Invalid operating_system returned by the database.",
    );
  });
});
