import type { DatabaseQueryClient } from "../database/client";
import type {
  TaskDeliveryEvidence,
  TaskDeliveryProviderTarget,
  TaskDeliveryRecord,
  TaskDeliveryRevisionReview,
  TaskDeliveryStore,
  TaskDeliveryWriteResult,
} from "./contracts";
import {
  assertDelivery,
  assertEvidence,
  assertReview,
  clone,
  deliveryColumns,
  deliveryValues,
  evidenceColumns,
  evidenceKey,
  evidenceValues,
  mapDelivery,
  mapEvidence,
  mapReview,
  pullRequestCollision,
  readDelivery,
  readLatestEvidence,
  reviewColumns,
  reviewKey,
  reviewRequestValues,
  sameDelivery,
  sameReviewDecision,
  sameReviewRequest,
  targetKey,
  type DeliveryRow,
  type EvidenceRow,
  type ReviewRow,
} from "./store-codec";

export type {
  TaskCompletionPolicy,
  TaskDeliveryDeploymentEvidence,
  TaskDeliveryEvidence,
  TaskDeliveryProvider,
  TaskDeliveryProviderMutationResult,
  TaskDeliveryProviderObservation,
  TaskDeliveryProviderTarget,
  TaskDeliveryRecord,
  TaskDeliveryRequiredCheck,
  TaskDeliveryRevisionReview,
  TaskDeliveryStore,
  TaskDeliveryWriteResult,
} from "./contracts";

export class PostgresTaskDeliveryStore implements TaskDeliveryStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async ensure(input: TaskDeliveryRecord): Promise<TaskDeliveryWriteResult> {
    assertDelivery(input);
    let result;
    try {
      result = await this.client.query<DeliveryRow>(
        `insert into task_deliveries (
           id, owner_user_id, origin_execution_id, provider_kind, repository_id,
           task_id, branch, pull_request_number, completion_policy,
           deployment_environment, version, created_at, updated_at
         ) values ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (owner_user_id, provider_kind, repository_id, task_id, branch)
         do nothing returning ${deliveryColumns}`,
        deliveryValues(input),
      );
    } catch (error) {
      if (isPullRequestBindingConflict(error)) return { kind: "conflict" };
      throw error;
    }
    if (result.rows[0])
      return { delivery: mapDelivery(result.rows[0]), kind: "created" };
    const existing = await this.readByTarget(input.ownerUserId, input);
    return existing && sameDelivery(existing, input)
      ? { delivery: existing, kind: "replayed" }
      : { kind: "conflict" };
  }

  async readByTarget(ownerUserId: string, target: TaskDeliveryProviderTarget) {
    const result = await this.client.query<DeliveryRow>(
      `select ${deliveryColumns} from task_deliveries
        where owner_user_id=$1 and provider_kind=$2 and repository_id=$3
          and task_id=$4 and branch=$5`,
      [
        ownerUserId,
        target.providerKind,
        target.repositoryId,
        target.taskId,
        target.branch,
      ],
    );
    return result.rows[0] ? mapDelivery(result.rows[0]) : undefined;
  }

  readById(ownerUserId: string, deliveryId: string) {
    return readDelivery(this.client, ownerUserId, deliveryId);
  }

  async readByExecution(ownerUserId: string, originExecutionId: string) {
    const result = await this.client.query<DeliveryRow>(
      `select ${deliveryColumns} from task_deliveries
        where owner_user_id=$1 and origin_execution_id=$2::uuid`,
      [ownerUserId, originExecutionId],
    );
    return result.rows[0] ? mapDelivery(result.rows[0]) : undefined;
  }

  async listByTask(input: {
    before?: { createdAt: string; id: string };
    limit: number;
    ownerUserId: string;
    taskId: string;
  }) {
    const result = await this.client.query<DeliveryRow>(
      `select ${deliveryColumns} from task_deliveries
        where owner_user_id=$1 and task_id=$2
          and ($3::timestamptz is null or (created_at,id)<($3::timestamptz,$4::uuid))
        order by created_at desc,id desc limit $5`,
      [
        input.ownerUserId,
        input.taskId,
        input.before?.createdAt ?? null,
        input.before?.id ?? null,
        input.limit,
      ],
    );
    return result.rows.map(mapDelivery);
  }

  async bindPullRequest(input: {
    deliveryId: string;
    expectedVersion: number;
    ownerUserId: string;
    pullRequestNumber: number;
    updatedAt: string;
  }): Promise<TaskDeliveryWriteResult> {
    let result;
    try {
      result = await this.client.query<DeliveryRow>(
        `update task_deliveries set pull_request_number=$4, version=version+1, updated_at=$5
          where id=$1::uuid and owner_user_id=$2 and version=$3
            and (pull_request_number is null or pull_request_number=$4)
          returning ${deliveryColumns}`,
        [
          input.deliveryId,
          input.ownerUserId,
          input.expectedVersion,
          input.pullRequestNumber,
          input.updatedAt,
        ],
      );
    } catch (error) {
      if (isPullRequestBindingConflict(error)) return { kind: "conflict" };
      throw error;
    }
    if (result.rows[0])
      return { delivery: mapDelivery(result.rows[0]), kind: "updated" };
    const existing = await readDelivery(
      this.client,
      input.ownerUserId,
      input.deliveryId,
    );
    return existing?.pullRequestNumber === input.pullRequestNumber
      ? { delivery: existing, kind: "replayed" }
      : { kind: "conflict" };
  }

  async appendEvidence(input: Omit<TaskDeliveryEvidence, "revision">) {
    assertEvidence(input);
    const run = async (client: DatabaseQueryClient) => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [
        `task-delivery-evidence:${input.ownerUserId}:${input.deliveryId}`,
      ]);
      const latest = await readLatestEvidence(
        client,
        input.ownerUserId,
        input.deliveryId,
      );
      if (latest?.fingerprint === input.fingerprint) return latest;
      const revision = (latest?.revision ?? 0) + 1;
      const observation = input as TaskDeliveryEvidence;
      const result = await client.query<EvidenceRow>(
        `insert into task_delivery_evidence (
           delivery_id, owner_user_id, evidence_revision, observing_execution_id,
           source_commit_sha, task_state, pull_request_number, pull_request_base_branch,
           pull_request_head_sha, pull_request_state, pull_request_draft,
           checks_state, checks_fingerprint_sha256, checks_commit_sha,
           required_checks, review_state, review_commit_sha,
           review_fingerprint_sha256, review_request_fingerprint_sha256,
           review_unresolved_threads, review_checked_at, preview_state,
           preview_head_sha, merge_commit_sha, deployment_environment,
           deployed_commit_sha, running_version, deployment_health,
           origin_reachable, origin_fingerprint_sha256, fingerprint_sha256, observed_at
         ) select $1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,
                  $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32
           from task_deliveries d join task_executions e
             on e.id=$4::uuid and e.owner_user_id=$2
            and e.repository_id=d.repository_id and e.task_id=d.task_id and e.branch=d.branch
          where d.id=$1::uuid and d.owner_user_id=$2
            and d.pull_request_number is not distinct from $7
         returning ${evidenceColumns}`,
        evidenceValues(observation, revision),
      );
      if (!result.rows[0])
        throw new Error("Task delivery evidence target does not match.");
      return mapEvidence(result.rows[0]);
    };
    return this.client.transaction
      ? this.client.transaction(run)
      : run(this.client);
  }

  latestEvidence(ownerUserId: string, deliveryId: string) {
    return readLatestEvidence(this.client, ownerUserId, deliveryId);
  }

  async requestReview(input: TaskDeliveryRevisionReview) {
    assertReview(input);
    const result = await this.client.query<ReviewRow>(
      `insert into task_delivery_revision_reviews (
         id, delivery_id, owner_user_id, pull_request_number, pull_request_head_sha,
         evidence_revision, summary_fingerprint_sha256, state,
         requested_by_kind, requested_by_id, requested_at
       ) values ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,'requested',$8,$9,$10)
       on conflict (delivery_id, owner_user_id, pull_request_head_sha) do nothing
       returning ${reviewColumns}`,
      reviewRequestValues(input),
    );
    if (result.rows[0]) return "created" as const;
    const existing = await this.readReview(
      input.ownerUserId,
      input.deliveryId,
      input.pullRequestHeadCommit,
    );
    return existing && sameReviewRequest(existing, input)
      ? ("replayed" as const)
      : ("conflict" as const);
  }

  async readReview(
    ownerUserId: string,
    deliveryId: string,
    pullRequestHeadCommit: string,
  ) {
    const result = await this.client.query<ReviewRow>(
      `select ${reviewColumns} from task_delivery_revision_reviews
        where owner_user_id=$1 and delivery_id=$2::uuid and pull_request_head_sha=$3`,
      [ownerUserId, deliveryId, pullRequestHeadCommit],
    );
    return result.rows[0] ? mapReview(result.rows[0]) : undefined;
  }

  async readReviewById(
    ownerUserId: string,
    deliveryId: string,
    reviewId: string,
  ) {
    const result = await this.client.query<ReviewRow>(
      `select ${reviewColumns} from task_delivery_revision_reviews
        where owner_user_id=$1 and delivery_id=$2::uuid and id=$3::uuid`,
      [ownerUserId, deliveryId, reviewId],
    );
    return result.rows[0] ? mapReview(result.rows[0]) : undefined;
  }

  async decideReview(input: {
    decidedAt: string;
    decidedBy: NonNullable<TaskDeliveryRevisionReview["decidedBy"]>;
    deliveryId: string;
    ownerUserId: string;
    pullRequestHeadCommit: string;
    reviewId: string;
    state: "approved" | "rejected";
  }) {
    const result = await this.client.query<ReviewRow>(
      `update task_delivery_revision_reviews set state=$4, decided_by_kind=$5,
          decided_by_id=$6, decided_at=$7
        where owner_user_id=$1 and delivery_id=$2::uuid and pull_request_head_sha=$3
          and id=$8::uuid
          and state='requested' returning ${reviewColumns}`,
      [
        input.ownerUserId,
        input.deliveryId,
        input.pullRequestHeadCommit,
        input.state,
        input.decidedBy.kind,
        input.decidedBy.id,
        input.decidedAt,
        input.reviewId,
      ],
    );
    if (result.rows[0]) return "updated" as const;
    const existing = await this.readReview(
      input.ownerUserId,
      input.deliveryId,
      input.pullRequestHeadCommit,
    );
    return existing && sameReviewDecision(existing, input)
      ? ("replayed" as const)
      : ("conflict" as const);
  }
}

export class MemoryTaskDeliveryStore implements TaskDeliveryStore {
  private readonly deliveries = new Map<string, TaskDeliveryRecord>();
  private readonly evidence = new Map<string, TaskDeliveryEvidence[]>();
  private readonly reviews = new Map<string, TaskDeliveryRevisionReview>();

  constructor(
    private readonly executionTarget?: (
      ownerUserId: string,
      executionId: string,
    ) => TaskDeliveryProviderTarget | undefined,
  ) {}

  async ensure(input: TaskDeliveryRecord): Promise<TaskDeliveryWriteResult> {
    assertDelivery(input);
    const key = targetKey(input.ownerUserId, input);
    const existing = this.deliveries.get(key);
    if (existing)
      return sameDelivery(existing, input)
        ? { delivery: clone(existing), kind: "replayed" }
        : { kind: "conflict" };
    if (
      [...this.deliveries.values()].some((delivery) =>
        pullRequestCollision(delivery, input),
      )
    ) {
      return { kind: "conflict" };
    }
    this.deliveries.set(key, clone(input));
    return { delivery: clone(input), kind: "created" };
  }

  async readByTarget(ownerUserId: string, target: TaskDeliveryProviderTarget) {
    const delivery = this.deliveries.get(targetKey(ownerUserId, target));
    return delivery ? clone(delivery) : undefined;
  }

  async readById(ownerUserId: string, deliveryId: string) {
    const delivery = this.findDelivery(ownerUserId, deliveryId);
    return delivery ? clone(delivery) : undefined;
  }

  async readByExecution(ownerUserId: string, originExecutionId: string) {
    const delivery = [...this.deliveries.values()].find(
      (entry) =>
        entry.ownerUserId === ownerUserId &&
        entry.originExecutionId === originExecutionId,
    );
    return delivery ? clone(delivery) : undefined;
  }

  async listByTask(input: {
    before?: { createdAt: string; id: string };
    limit: number;
    ownerUserId: string;
    taskId: string;
  }) {
    return [...this.deliveries.values()]
      .filter(
        (entry) =>
          entry.ownerUserId === input.ownerUserId &&
          entry.taskId === input.taskId &&
          (!input.before ||
            entry.createdAt < input.before.createdAt ||
            (entry.createdAt === input.before.createdAt &&
              entry.id < input.before.id)),
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, input.limit)
      .map(clone);
  }

  async bindPullRequest(input: {
    deliveryId: string;
    expectedVersion: number;
    ownerUserId: string;
    pullRequestNumber: number;
    updatedAt: string;
  }): Promise<TaskDeliveryWriteResult> {
    const current = this.findDelivery(input.ownerUserId, input.deliveryId);
    if (!current) return { kind: "conflict" };
    if (current.pullRequestNumber === input.pullRequestNumber) {
      return { delivery: clone(current), kind: "replayed" };
    }
    if (
      current.pullRequestNumber !== undefined ||
      current.version !== input.expectedVersion ||
      [...this.deliveries.values()].some((delivery) =>
        pullRequestCollision(delivery, {
          ...current,
          pullRequestNumber: input.pullRequestNumber,
        }),
      )
    )
      return { kind: "conflict" };
    current.pullRequestNumber = input.pullRequestNumber;
    current.updatedAt = input.updatedAt;
    current.version += 1;
    return { delivery: clone(current), kind: "updated" };
  }

  async appendEvidence(input: Omit<TaskDeliveryEvidence, "revision">) {
    assertEvidence(input);
    const delivery = this.findDelivery(input.ownerUserId, input.deliveryId);
    const observingTarget =
      input.observingExecutionId === delivery?.originExecutionId
        ? delivery
        : this.executionTarget?.(input.ownerUserId, input.observingExecutionId);
    if (
      !delivery ||
      delivery.pullRequestNumber !== input.pullRequest?.number ||
      !observingTarget ||
      !sameTarget(delivery, observingTarget)
    ) {
      throw new Error("Task delivery evidence target does not match.");
    }
    const list =
      this.evidence.get(evidenceKey(input.ownerUserId, input.deliveryId)) ?? [];
    const latest = list.at(-1);
    if (latest?.fingerprint === input.fingerprint) return clone(latest);
    const record: TaskDeliveryEvidence = {
      ...clone(input),
      revision: (latest?.revision ?? 0) + 1,
    };
    list.push(record);
    this.evidence.set(evidenceKey(input.ownerUserId, input.deliveryId), list);
    return clone(record);
  }

  async latestEvidence(ownerUserId: string, deliveryId: string) {
    const record = this.evidence
      .get(evidenceKey(ownerUserId, deliveryId))
      ?.at(-1);
    return record ? clone(record) : undefined;
  }

  async requestReview(input: TaskDeliveryRevisionReview) {
    assertReview(input);
    const evidence = await this.latestEvidence(
      input.ownerUserId,
      input.deliveryId,
    );
    if (
      !evidence ||
      evidence.revision !== input.evidenceRevision ||
      evidence.pullRequest?.number !== input.pullRequestNumber ||
      evidence.pullRequest.headCommit !== input.pullRequestHeadCommit
    )
      return "conflict" as const;
    const key = reviewKey(
      input.ownerUserId,
      input.deliveryId,
      input.pullRequestHeadCommit,
    );
    const existing = this.reviews.get(key);
    if (existing)
      return sameReviewRequest(existing, input)
        ? ("replayed" as const)
        : ("conflict" as const);
    this.reviews.set(key, clone(input));
    return "created" as const;
  }

  async readReview(
    ownerUserId: string,
    deliveryId: string,
    pullRequestHeadCommit: string,
  ) {
    const review = this.reviews.get(
      reviewKey(ownerUserId, deliveryId, pullRequestHeadCommit),
    );
    return review ? clone(review) : undefined;
  }

  async readReviewById(
    ownerUserId: string,
    deliveryId: string,
    reviewId: string,
  ) {
    const review = [...this.reviews.values()].find(
      (entry) =>
        entry.ownerUserId === ownerUserId &&
        entry.deliveryId === deliveryId &&
        entry.id === reviewId,
    );
    return review ? clone(review) : undefined;
  }

  async decideReview(input: {
    decidedAt: string;
    decidedBy: NonNullable<TaskDeliveryRevisionReview["decidedBy"]>;
    deliveryId: string;
    ownerUserId: string;
    pullRequestHeadCommit: string;
    reviewId: string;
    state: "approved" | "rejected";
  }) {
    const review = this.reviews.get(
      reviewKey(
        input.ownerUserId,
        input.deliveryId,
        input.pullRequestHeadCommit,
      ),
    );
    if (!review || review.id !== input.reviewId) return "conflict" as const;
    if (sameReviewDecision(review, input)) return "replayed" as const;
    if (review.state !== "requested") return "conflict" as const;
    review.state = input.state;
    review.decidedAt = input.decidedAt;
    review.decidedBy = clone(input.decidedBy);
    return "updated" as const;
  }

  private findDelivery(ownerUserId: string, deliveryId: string) {
    return [...this.deliveries.values()].find(
      (entry) => entry.ownerUserId === ownerUserId && entry.id === deliveryId,
    );
  }
}

function sameTarget(
  left: TaskDeliveryProviderTarget,
  right: TaskDeliveryProviderTarget,
) {
  return (
    left.providerKind === right.providerKind &&
    left.repositoryId === right.repositoryId &&
    left.taskId === right.taskId &&
    left.branch === right.branch
  );
}

function isPullRequestBindingConflict(error: unknown) {
  const databaseError = error as { code?: unknown; constraint?: unknown };
  return (
    databaseError.code === "23505" &&
    databaseError.constraint === "task_deliveries_provider_pull_request_unique"
  );
}
