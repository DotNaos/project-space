import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createMachineConnectionBackend,
  type MachineConnectionBackendOptions,
} from "../server/machine-connection-backend";
import type {
  DatabaseQueryClient,
  DatabaseQueryResult,
} from "../server/database/client";

interface QueryCall {
  sql: string;
  values: readonly unknown[];
}

const physicalMachineId = "11111111-1111-4111-8111-111111111111";

class CompositionDatabase implements DatabaseQueryClient {
  readonly calls: QueryCall[] = [];
  cleanupCount = 0;
  credentialExpired = false;
  credentialRevoked = false;
  identityRevoked = false;
  membershipBound = true;
  requestCleanupCount = 0;
  recentAttemptCount = 0;

  async query<Row>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<DatabaseQueryResult<Row>> {
    this.calls.push({ sql, values });

    if (sql.includes("accepted_count")) {
      return this.result([{ accepted_count: this.recentAttemptCount }]);
    }
    if (sql.includes("with expired_requests as")) {
      return {
        rowCount: this.requestCleanupCount,
        rows: Array.from({ length: this.requestCleanupCount }, () => ({
          removed: 1,
        })) as Row[],
      };
    }
    if (sql.includes("from machine_connection_requests")) {
      return this.result([this.requestRow()]);
    }
    if (sql.includes("from physical_machines")) {
      return this.result([{ id: physicalMachineId, kind: "physical", name: "Office PC" }]);
    }
    if (sql.includes("update machine_connection_requests")) {
      return this.result([
        { expired_by_boundary: false, status: values[2] },
      ]);
    }
    if (
      sql.includes("from machine_identities mi") &&
      sql.includes("join connector_credentials")
    ) {
      if (values[0] !== "machine-1" || !this.membershipBound) {
        return this.result([]);
      }
      return this.result([this.machineRow()]);
    }
    if (sql.includes("from machine_identities") && sql.includes("for update")) {
      return values[0] === "machine-1"
        ? this.result([{
            current_credential_id: "credential-1",
            revoked_at: this.identityRevoked ? this.revokedAt() : null,
          }])
        : this.result([]);
    }
    if (sql.includes("from connector_credentials") && sql.includes("for update")) {
      return this.result([{
        credential_expired: this.credentialExpired,
        credential_id: "credential-1",
        credential_matches: values[2] === this.credentialHash(),
        credential_revoked_at: this.credentialRevoked ? this.revokedAt() : null,
      }]);
    }
    if (sql.includes("update connector_credentials")) {
      return this.result([{ id: "credential-1" }]);
    }
    if (sql.includes("update machine_identities")) {
      return this.result([{ id: "machine-1" }]);
    }
    if (sql.includes("with expired as")) {
      return {
        rowCount: this.cleanupCount,
        rows: Array.from({ length: this.cleanupCount }, () => ({ removed: 1 })) as Row[],
      };
    }
    return this.result([]);
  }

  async transaction<Result>(
    operation: (client: DatabaseQueryClient) => Promise<Result>,
  ) {
    return operation(this);
  }

  private machineRow() {
    const effectivelyRevoked =
      this.credentialExpired || this.credentialRevoked || this.identityRevoked;
    return {
      architecture: "amd64",
      client_version: "0.2.0",
      created_at: new Date("2026-07-01T00:00:00.000Z"),
      credential_expires_at: this.credentialExpired
        ? this.revokedAt()
        : new Date("2099-01-01T00:00:00.000Z"),
      credential_hash: this.credentialHash(),
      current_credential_id: "credential-1",
      effective_revoked_at: effectivelyRevoked ? this.revokedAt() : null,
      hostname: "os-pc",
      id: "machine-1",
      last_seen_at: null,
      name: "OS PC",
      operating_system: "linux",
      owner_user_id: "user-oli",
      public_key: Buffer.alloc(32, 4).toString("base64url"),
      revoked_at: this.identityRevoked ? this.revokedAt() : null,
    };
  }

  private credentialHash() {
    return createHash("sha256")
      .update("machine-credential", "utf8")
      .digest("hex");
  }

  private revokedAt() {
    return new Date("2026-07-01T00:00:00.000Z");
  }

  private requestRow() {
    return {
      approval_challenge: null,
      approved_at: null,
      approved_by_user_id: null,
      architecture: "amd64",
      client_version: "0.2.0",
      consumed_at: null,
      created_at: new Date("2026-07-01T00:00:00.000Z"),
      denied_at: null,
      expires_at: new Date("2099-01-01T00:00:00.000Z"),
      hostname: "os-pc",
      id: "request-1",
      name: "OS PC",
      operating_system: "linux",
      poll_token_hash: "a".repeat(64),
      physical_machine_id: null,
      public_key: Buffer.alloc(32, 4).toString("base64url"),
      status: "pending",
    };
  }

  private result<Row>(rows: unknown[]): DatabaseQueryResult<Row> {
    return { rows: rows as Row[] };
  }
}

const openServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function backendOptions(
  databaseClient: CompositionDatabase,
  overrides: Partial<MachineConnectionBackendOptions> = {},
): MachineConnectionBackendOptions {
  return {
    databaseClient,
    isMachineOnline: () => false,
    publicOrigin: "https://projects.os-home.net",
    rateLimitSecret: Buffer.alloc(32, 7),
    readAuthenticatedUserId: async () => "user-oli",
    ...overrides,
  };
}

async function startBackend(
  backend: ReturnType<typeof createMachineConnectionBackend>,
) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    void backend.handleRequest(request, response, url).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Machine connection backend did not bind.");
  }
  const running = {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    origin: `http://127.0.0.1:${address.port}`,
  };
  openServers.push(running);
  return running;
}

describe("machine connection backend composition", () => {
  test("resolves only the current bound machine credential to trusted identity", async () => {
    const validDatabase = new CompositionDatabase();
    const validBackend = createMachineConnectionBackend(
      backendOptions(validDatabase),
    );

    await expect(
      validBackend.resolveMachineCredentialIdentity(
        "machine-credential",
        "machine-1",
      ),
    ).resolves.toEqual({
      hostId: "os-pc",
      machineId: "machine-1",
      userId: "user-oli",
    });
    await expect(
      validBackend.authenticateConnectorCredential(
        "machine-credential",
        "machine-1",
      ),
    ).resolves.toBe(true);

    const rejectedCases = [
      {
        configure() {},
        machineId: "machine-1",
        name: "wrong token",
        token: "wrong-token",
      },
      {
        configure() {},
        machineId: "machine-other",
        name: "wrong machine",
        token: "machine-credential",
      },
      {
        configure(database: CompositionDatabase) {
          database.identityRevoked = true;
        },
        machineId: "machine-1",
        name: "revoked identity",
        token: "machine-credential",
      },
      {
        configure(database: CompositionDatabase) {
          database.credentialRevoked = true;
        },
        machineId: "machine-1",
        name: "revoked credential",
        token: "machine-credential",
      },
      {
        configure(database: CompositionDatabase) {
          database.credentialExpired = true;
        },
        machineId: "machine-1",
        name: "expired credential",
        token: "machine-credential",
      },
      {
        configure(database: CompositionDatabase) {
          database.membershipBound = false;
        },
        machineId: "machine-1",
        name: "unbound membership",
        token: "machine-credential",
      },
    ];

    for (const rejected of rejectedCases) {
      const database = new CompositionDatabase();
      rejected.configure(database);
      const backend = createMachineConnectionBackend(backendOptions(database));

      await expect(
        backend.resolveMachineCredentialIdentity(
          rejected.token,
          rejected.machineId,
        ),
        rejected.name,
      ).resolves.toBeNull();
      await expect(
        backend.authenticateConnectorCredential(
          rejected.token,
          rejected.machineId,
        ),
        rejected.name,
      ).resolves.toBe(false);
    }
  });

  test("passes authenticated browser approval and live presence into the service", async () => {
    const database = new CompositionDatabase();
    const authenticatedHeaders: Array<string | undefined> = [];
    const onlineChecks: Array<{ credential: string; machineId: string }> = [];
    const backend = createMachineConnectionBackend(
      backendOptions(database, {
        isMachineOnline(machineId, credential) {
          onlineChecks.push({ credential, machineId });
          return true;
        },
        async readAuthenticatedUserId(request) {
          authenticatedHeaders.push(request.headers.authorization);
          return request.headers.authorization === "Bearer browser-session"
            ? "user-browser"
            : null;
        },
      }),
    );
    const server = await startBackend(backend);

    const approval = await fetch(
      `${server.origin}/api/machine-connections/request-1/approve`,
      {
        body: JSON.stringify({ physicalMachineId }),
        headers: {
          Authorization: "Bearer browser-session",
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    expect(approval.status).toBe(200);
    expect(authenticatedHeaders).toEqual(["Bearer browser-session"]);
    const approvalUpdate = database.calls.find((call) =>
      call.sql.includes("update machine_connection_requests"),
    );
    expect(approvalUpdate?.values[5]).toBe("user-browser");

    const status = await fetch(
      `${server.origin}/api/machines/machine-1/connection`,
      { headers: { Authorization: "Bearer machine-credential" } },
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      machineId: "machine-1",
      status: "online",
    });
    expect(onlineChecks).toEqual([
      { credential: "machine-credential", machineId: "machine-1" },
    ]);
  });

  test("gates request creation through the limiter and delegates bounded cleanup", async () => {
    const database = new CompositionDatabase();
    database.recentAttemptCount = 5;
    database.cleanupCount = 3;
    database.requestCleanupCount = 2;
    const backend = createMachineConnectionBackend(backendOptions(database));
    const server = await startBackend(backend);

    const creation = await fetch(`${server.origin}/api/machine-connections`, {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(creation.status).toBe(429);
    expect(creation.headers.get("retry-after")).toBe("60");
    expect(
      database.calls.some((call) =>
        call.sql.includes("insert into machine_connection_requests"),
      ),
    ).toBe(false);

    await expect(backend.cleanupRateLimitEvents()).resolves.toBe(3);
    expect(
      database.calls.some((call) => call.sql.includes("with expired as")),
    ).toBe(true);
    await expect(backend.cleanupExpiredRequests()).resolves.toBe(2);
    expect(
      database.calls.some((call) =>
        call.sql.includes("with expired_requests as"),
      ),
    ).toBe(true);
  });
});
