import { describe, expect, test } from "bun:test";

import type {
  DatabaseQueryClient,
  DatabaseQueryResult,
} from "../server/database/client";
import { databaseMigrations } from "../server/database/migrations";
import {
  taskDeliveryMigrationId,
  taskDeliveryMigrationSql,
} from "../server/database/task-delivery-migration";
import {
  MemoryTaskDeliveryStore,
  PostgresTaskDeliveryStore,
  type TaskDeliveryEvidence,
  type TaskDeliveryRecord,
  type TaskDeliveryRevisionReview,
} from "../server/task-delivery/store";

const owner = "owner-one";
const executionId = "11111111-1111-4111-8111-111111111111";
const deliveryId = "22222222-2222-4222-8222-222222222222";
const reviewId = "33333333-3333-4333-8333-333333333333";
const now = "2026-08-09T12:00:00.000Z";
const head = "a".repeat(40);

const delivery: TaskDeliveryRecord = {
  branch: "issue-562-delivery",
  createdAt: now,
  id: deliveryId,
  originExecutionId: executionId,
  ownerUserId: owner,
  policy: { deploymentEnvironment: "prod", kind: "deployed_healthy" },
  providerKind: "github",
  repositoryId: "github:DotNaos/project-space",
  taskId: "github:DotNaos/project-space#562",
  updatedAt: now,
  version: 1,
};

const evidence: Omit<TaskDeliveryEvidence, "revision"> = {
  checks: {
    commit: head,
    fingerprint: "b".repeat(64),
    required: [
      {
        checkedAt: now,
        commit: head,
        id: "check-1",
        name: "Fast CI",
        requiredAppId: 15_368,
        state: "passing",
      },
    ],
    state: "passing",
  },
  deliveryId,
  fingerprint: "c".repeat(64),
  observedAt: now,
  observingExecutionId: executionId,
  ownerUserId: owner,
  preview: { headCommit: head, state: "ready" },
  pullRequest: {
    baseBranch: "main",
    draft: false,
    headCommit: head,
    number: 562,
    state: "open",
  },
  review: {
    checkedAt: now,
    commit: head,
    fingerprint: "d".repeat(64),
    requestFingerprint: "9".repeat(64),
    state: "approved",
    unresolvedThreads: 2,
  },
  sourceCommit: head,
  taskState: "open",
};

const review: TaskDeliveryRevisionReview = {
  deliveryId,
  evidenceRevision: 1,
  id: reviewId,
  ownerUserId: owner,
  pullRequestHeadCommit: head,
  pullRequestNumber: 562,
  requestedAt: now,
  requestedBy: { id: "orchestrator-one", kind: "orchestrator" },
  state: "requested",
  summaryFingerprint: "e".repeat(64),
};

class FakeDatabase implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly responses: Array<DatabaseQueryResult<unknown>> = [];
  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    return (this.responses.shift() ?? { rows: [] }) as DatabaseQueryResult<Row>;
  }
  async transaction<Result>(
    run: (client: DatabaseQueryClient) => Promise<Result>,
  ) {
    return run(this);
  }
}

class PullRequestConflictDatabase implements DatabaseQueryClient {
  readonly calls: string[] = [];
  async query<Row>(sql: string): Promise<DatabaseQueryResult<Row>> {
    this.calls.push(sql);
    throw Object.assign(new Error("duplicate pull request"), {
      code: "23505",
      constraint: "task_deliveries_provider_pull_request_unique",
    });
  }
}

describe("task delivery migration", () => {
  test("registers exact owner-scoped evidence, review, and unresolved operation fences", () => {
    expect(taskDeliveryMigrationId).toBe("0037_task_delivery");
    expect(
      databaseMigrations.find(
        (migration) => migration.id === taskDeliveryMigrationId,
      ),
    ).toEqual({
      id: taskDeliveryMigrationId,
      sql: taskDeliveryMigrationSql,
    });
    expect(taskDeliveryMigrationSql).toContain(
      "execution_operations_one_unresolved_scope",
    );
    expect(taskDeliveryMigrationSql).toContain(
      "state in ('dispatched', 'confirmed', 'uncertain')",
    );
    expect(taskDeliveryMigrationSql).toContain("create table task_deliveries");
    expect(taskDeliveryMigrationSql).toContain(
      "create table task_delivery_evidence",
    );
    expect(taskDeliveryMigrationSql).toContain(
      "create table task_delivery_revision_reviews",
    );
    expect(taskDeliveryMigrationSql).toContain("origin_fingerprint_sha256");
    expect(taskDeliveryMigrationSql).toContain(
      "review_request_fingerprint_sha256",
    );
    expect(taskDeliveryMigrationSql).toContain(
      "review_unresolved_threads integer check (review_unresolved_threads between 0 and 1000)",
    );
    expect(taskDeliveryMigrationSql).not.toMatch(
      /access_token|refresh_token|device_code|user_code/,
    );
  });
});

describe("memory task delivery store", () => {
  test("reuses one canonical target across successor executions but not changed policy", async () => {
    const store = new MemoryTaskDeliveryStore();
    expect((await store.ensure(delivery)).kind).toBe("created");
    const successor = {
      ...delivery,
      id: "44444444-4444-4444-8444-444444444444",
      originExecutionId: "55555555-5555-4555-8555-555555555555",
    };
    expect(await store.ensure(successor)).toMatchObject({
      kind: "replayed",
      delivery: { id: deliveryId },
    });
    expect(
      await store.ensure({ ...successor, policy: { kind: "merged" } }),
    ).toEqual({ kind: "conflict" });
    expect(await store.readByTarget(owner, delivery)).toMatchObject({
      id: deliveryId,
    });
    expect(await store.readById("another-owner", deliveryId)).toBeUndefined();
  });

  test("binds one PR immutably and rejects cross-task reuse", async () => {
    const store = new MemoryTaskDeliveryStore();
    await store.ensure(delivery);
    expect(
      await store.bindPullRequest({
        deliveryId,
        expectedVersion: 1,
        ownerUserId: owner,
        pullRequestNumber: 562,
        updatedAt: now,
      }),
    ).toMatchObject({
      kind: "updated",
      delivery: { pullRequestNumber: 562, version: 2 },
    });
    expect(
      (
        await store.bindPullRequest({
          deliveryId,
          expectedVersion: 2,
          ownerUserId: owner,
          pullRequestNumber: 999,
          updatedAt: now,
        })
      ).kind,
    ).toBe("conflict");
    expect(
      (
        await store.ensure({
          ...delivery,
          branch: "another-branch",
          id: "66666666-6666-4666-8666-666666666666",
          pullRequestNumber: 562,
          taskId: "github:DotNaos/project-space#999",
        })
      ).kind,
    ).toBe("conflict");
  });

  test("appends evidence revisions, stores no URLs, and invalidates approval on head change", async () => {
    const store = new MemoryTaskDeliveryStore();
    await store.ensure(delivery);
    await store.bindPullRequest({
      deliveryId,
      expectedVersion: 1,
      ownerUserId: owner,
      pullRequestNumber: 562,
      updatedAt: now,
    });
    expect((await store.appendEvidence(evidence)).revision).toBe(1);
    expect((await store.appendEvidence(evidence)).revision).toBe(1);
    expect(
      (await store.latestEvidence(owner, deliveryId))?.review
        .requestFingerprint,
    ).toBe("9".repeat(64));
    expect(
      (await store.latestEvidence(owner, deliveryId))?.review.unresolvedThreads,
    ).toBe(2);
    expect(await store.requestReview(review)).toBe("created");
    expect(
      await store.decideReview({
        decidedAt: now,
        decidedBy: { id: owner, kind: "human" },
        deliveryId,
        ownerUserId: owner,
        pullRequestHeadCommit: head,
        reviewId,
        state: "approved",
      }),
    ).toBe("updated");
    expect(
      (await store.readReviewById(owner, deliveryId, reviewId))?.state,
    ).toBe("approved");

    const nextHead = "f".repeat(40);
    await store.appendEvidence({
      ...evidence,
      checks: {
        ...evidence.checks,
        commit: nextHead,
        required: evidence.checks.required.map((check) => ({
          ...check,
          commit: nextHead,
        })),
      },
      fingerprint: "1".repeat(64),
      preview: { headCommit: nextHead, state: "pending" },
      pullRequest: { ...evidence.pullRequest!, headCommit: nextHead },
      review: {
        state: "required",
        checkedAt: now,
        commit: nextHead,
        fingerprint: "2".repeat(64),
      },
      sourceCommit: nextHead,
    });
    expect(await store.readReview(owner, deliveryId, nextHead)).toBeUndefined();
    expect(
      JSON.stringify(await store.latestEvidence(owner, deliveryId)),
    ).not.toMatch(/https?:|url/iu);
    expect(
      (await store.latestEvidence(owner, deliveryId))?.checks.required[0]
        ?.requiredAppId,
    ).toBe(15_368);
  });

  test("rejects evidence from an execution on another target and accepts an exact successor", async () => {
    const successorId = "88888888-8888-4888-8888-888888888888";
    const unrelatedId = "99999999-9999-4999-8999-999999999999";
    const store = new MemoryTaskDeliveryStore((_ownerUserId, candidate) =>
      candidate === successorId
        ? delivery
        : candidate === unrelatedId
          ? { ...delivery, taskId: "github:DotNaos/project-space#999" }
          : undefined,
    );
    await store.ensure(delivery);
    await store.bindPullRequest({
      deliveryId,
      expectedVersion: 1,
      ownerUserId: owner,
      pullRequestNumber: 562,
      updatedAt: now,
    });
    await expect(
      store.appendEvidence({
        ...evidence,
        observingExecutionId: unrelatedId,
      }),
    ).rejects.toThrow("target does not match");
    expect(
      (
        await store.appendEvidence({
          ...evidence,
          observingExecutionId: successorId,
        })
      ).revision,
    ).toBe(1);
  });

  test("rejects the same malformed evidence that PostgreSQL constraints reject", async () => {
    const memory = new MemoryTaskDeliveryStore();
    const database = new FakeDatabase();
    const postgres = new PostgresTaskDeliveryStore(database);
    const invalid = [
      { ...evidence, fingerprint: head },
      { ...evidence, sourceCommit: "1".repeat(64) },
      {
        ...evidence,
        review: { ...evidence.review, requestFingerprint: head },
      },
      {
        ...evidence,
        review: { ...evidence.review, unresolvedThreads: 1_001 },
      },
      { ...evidence, checks: { ...evidence.checks, commit: "1".repeat(64) } },
      {
        ...evidence,
        checks: {
          ...evidence.checks,
          required: evidence.checks.required.map((check) => ({
            ...check,
            requiredAppId: 0,
          })),
        },
      },
      {
        ...evidence,
        checks: {
          ...evidence.checks,
          required: Array.from({ length: 101 }, (_, index) => ({
            checkedAt: now,
            commit: head,
            id: `check-${index}`,
            name: `Check ${index}`,
            state: "passing" as const,
          })),
        },
      },
    ];
    for (const candidate of invalid) {
      await expect(memory.appendEvidence(candidate)).rejects.toThrow(
        "evidence is invalid",
      );
      await expect(postgres.appendEvidence(candidate)).rejects.toThrow(
        "evidence is invalid",
      );
    }
    expect(database.calls).toEqual([]);
  });

  test("lists only the owner task with a bounded stable cursor", async () => {
    const store = new MemoryTaskDeliveryStore();
    await store.ensure(delivery);
    await store.ensure({
      ...delivery,
      branch: "second",
      createdAt: "2026-08-09T13:00:00.000Z",
      id: "77777777-7777-4777-8777-777777777777",
    });
    expect(
      (
        await store.listByTask({
          limit: 1,
          ownerUserId: owner,
          taskId: delivery.taskId,
        })
      )[0]?.branch,
    ).toBe("second");
    expect(
      await store.listByTask({
        limit: 10,
        ownerUserId: "other",
        taskId: delivery.taskId,
      }),
    ).toEqual([]);
  });
});

describe("Postgres task delivery store", () => {
  test("persists canonical owner-target identity and immutable policy", async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [] }, { rows: [] });
    const store = new PostgresTaskDeliveryStore(database);
    expect(await store.ensure(delivery)).toEqual({ kind: "conflict" });
    expect(database.calls[0]?.sql).toContain(
      "on conflict (owner_user_id, provider_kind, repository_id, task_id, branch)",
    );
    expect(database.calls[0]?.values).toContain("deployed_healthy");
    expect(database.calls[0]?.values).toContain("prod");
  });

  test("returns conflict when another target already owns the provider pull request", async () => {
    const ensureDatabase = new PullRequestConflictDatabase();
    const ensureStore = new PostgresTaskDeliveryStore(ensureDatabase);
    expect(
      await ensureStore.ensure({ ...delivery, pullRequestNumber: 562 }),
    ).toEqual({ kind: "conflict" });

    const bindDatabase = new PullRequestConflictDatabase();
    const bindStore = new PostgresTaskDeliveryStore(bindDatabase);
    expect(
      await bindStore.bindPullRequest({
        deliveryId,
        expectedVersion: 1,
        ownerUserId: owner,
        pullRequestNumber: 562,
        updatedAt: now,
      }),
    ).toEqual({ kind: "conflict" });
  });

  test("allocates evidence revisions under a delivery lock and writes no raw URL", async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [] }, { rows: [] }, { rows: [] });
    const store = new PostgresTaskDeliveryStore(database);
    await expect(store.appendEvidence(evidence)).rejects.toThrow(
      "target does not match",
    );
    expect(database.calls[0]?.sql).toContain("pg_advisory_xact_lock");
    const insert = database.calls.find(({ sql }) =>
      sql.includes("insert into task_delivery_evidence"),
    );
    expect(insert?.sql).toContain("join task_executions");
    expect(insert?.sql).toContain(
      "d.pull_request_number is not distinct from $7",
    );
    expect(insert?.sql).not.toContain(
      "d.pull_request_number is not distinct from $6",
    );
    expect(insert?.sql).toContain("$15::jsonb");
    expect(insert?.sql).toContain("$32");
    expect(insert?.values).toHaveLength(32);
    expect(insert?.values[14]).toContain('"requiredAppId":15368');
    expect(insert?.values[18]).toBe("9".repeat(64));
    expect(insert?.values[19]).toBe(2);
    expect(`${insert?.sql}${JSON.stringify(insert?.values)}`).not.toMatch(
      /https?:|access.?token|origin_url/i,
    );
  });
});
