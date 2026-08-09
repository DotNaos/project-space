import type { DatabaseQueryClient } from "../database/client";
import type {
  TaskCompletionPolicy,
  TaskDeliveryEvidence,
  TaskDeliveryProviderTarget,
  TaskDeliveryRecord,
  TaskDeliveryRequiredCheck,
  TaskDeliveryRevisionReview,
} from "./contracts";

export interface DeliveryRow {
  branch: string;
  completion_policy: TaskCompletionPolicy["kind"];
  created_at: Date | string;
  deployment_environment: string | null;
  id: string;
  origin_execution_id: string;
  owner_user_id: string;
  provider_kind: string;
  pull_request_number: number | string | null;
  repository_id: string;
  task_id: string;
  updated_at: Date | string;
  version: number | string;
}

export interface EvidenceRow {
  checks_fingerprint_sha256: string | null;
  checks_commit_sha: string;
  checks_state: TaskDeliveryEvidence["checks"]["state"];
  delivery_id: string;
  deployed_commit_sha: string | null;
  deployment_environment: string | null;
  deployment_health:
    NonNullable<TaskDeliveryEvidence["deployment"]>["health"] | null;
  evidence_revision: number | string;
  fingerprint_sha256: string;
  merge_commit_sha: string | null;
  observed_at: Date | string;
  observing_execution_id: string;
  origin_fingerprint_sha256: string | null;
  origin_reachable: boolean | null;
  owner_user_id: string;
  preview_head_sha: string | null;
  preview_state: TaskDeliveryEvidence["preview"]["state"];
  pull_request_base_branch: string | null;
  pull_request_draft: boolean | null;
  pull_request_head_sha: string | null;
  pull_request_number: number | string | null;
  pull_request_state:
    NonNullable<TaskDeliveryEvidence["pullRequest"]>["state"] | null;
  required_checks: unknown;
  review_checked_at: Date | string | null;
  review_commit_sha: string | null;
  review_fingerprint_sha256: string | null;
  review_request_fingerprint_sha256: string | null;
  review_state: TaskDeliveryEvidence["review"]["state"];
  review_unresolved_threads: number | string | null;
  running_version: string | null;
  source_commit_sha: string;
  task_state: TaskDeliveryEvidence["taskState"];
}

export interface ReviewRow {
  decided_at: Date | string | null;
  decided_by_id: string | null;
  decided_by_kind: "human" | "provider" | null;
  delivery_id: string;
  evidence_revision: number | string;
  id: string;
  owner_user_id: string;
  pull_request_head_sha: string;
  pull_request_number: number | string;
  requested_at: Date | string;
  requested_by_id: string;
  requested_by_kind: "agent" | "human" | "orchestrator";
  state: TaskDeliveryRevisionReview["state"];
  summary_fingerprint_sha256: string;
}

export const deliveryColumns = `id, owner_user_id, origin_execution_id, provider_kind,
  repository_id, task_id, branch, pull_request_number, completion_policy,
  deployment_environment, version, created_at, updated_at`;
export const evidenceColumns = `delivery_id, owner_user_id, evidence_revision,
  observing_execution_id, source_commit_sha, task_state, pull_request_number,
  pull_request_base_branch, pull_request_head_sha, pull_request_state,
  pull_request_draft, checks_state, checks_fingerprint_sha256, checks_commit_sha,
  required_checks, review_state, review_commit_sha, review_fingerprint_sha256,
  review_request_fingerprint_sha256, review_unresolved_threads, review_checked_at,
  preview_state, preview_head_sha, merge_commit_sha,
  deployment_environment, deployed_commit_sha, running_version, deployment_health,
  origin_reachable, origin_fingerprint_sha256, fingerprint_sha256, observed_at`;
export const reviewColumns = `id, delivery_id, owner_user_id, pull_request_number,
  pull_request_head_sha, evidence_revision, summary_fingerprint_sha256, state,
  requested_by_kind, requested_by_id, requested_at, decided_by_kind,
  decided_by_id, decided_at`;

export async function readDelivery(
  client: DatabaseQueryClient,
  ownerUserId: string,
  deliveryId: string,
) {
  const result = await client.query<DeliveryRow>(
    `select ${deliveryColumns} from task_deliveries where owner_user_id=$1 and id=$2::uuid`,
    [ownerUserId, deliveryId],
  );
  return result.rows[0] ? mapDelivery(result.rows[0]) : undefined;
}

export async function readLatestEvidence(
  client: DatabaseQueryClient,
  ownerUserId: string,
  deliveryId: string,
) {
  const result = await client.query<EvidenceRow>(
    `select ${evidenceColumns} from task_delivery_evidence
      where owner_user_id=$1 and delivery_id=$2::uuid
      order by evidence_revision desc limit 1`,
    [ownerUserId, deliveryId],
  );
  return result.rows[0] ? mapEvidence(result.rows[0]) : undefined;
}

export function mapDelivery(row: DeliveryRow): TaskDeliveryRecord {
  const policy: TaskCompletionPolicy =
    row.completion_policy === "deployed_healthy"
      ? {
          deploymentEnvironment: row.deployment_environment!,
          kind: "deployed_healthy",
        }
      : { kind: row.completion_policy };
  return {
    branch: row.branch,
    createdAt: iso(row.created_at),
    id: row.id,
    originExecutionId: row.origin_execution_id,
    ownerUserId: row.owner_user_id,
    policy,
    providerKind: row.provider_kind,
    ...(row.pull_request_number === null
      ? {}
      : { pullRequestNumber: Number(row.pull_request_number) }),
    repositoryId: row.repository_id,
    taskId: row.task_id,
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
  };
}

export function mapEvidence(row: EvidenceRow): TaskDeliveryEvidence {
  const pullRequest =
    row.pull_request_number === null
      ? undefined
      : {
          baseBranch: row.pull_request_base_branch!,
          draft: row.pull_request_draft!,
          headCommit: row.pull_request_head_sha!,
          number: Number(row.pull_request_number),
          state: row.pull_request_state!,
        };
  const deployment =
    row.deployment_environment === null
      ? undefined
      : {
          deployedCommit: row.deployed_commit_sha!,
          environment: row.deployment_environment,
          health: row.deployment_health!,
          originFingerprint: row.origin_fingerprint_sha256!,
          originReachable: row.origin_reachable!,
          ...(row.running_version
            ? { runningVersion: row.running_version }
            : {}),
        };
  return {
    checks: {
      commit: row.checks_commit_sha,
      ...(row.checks_fingerprint_sha256
        ? { fingerprint: row.checks_fingerprint_sha256 }
        : {}),
      required: mapRequiredChecks(row.required_checks),
      state: row.checks_state,
    },
    deliveryId: row.delivery_id,
    ...(deployment ? { deployment } : {}),
    fingerprint: row.fingerprint_sha256,
    ...(row.merge_commit_sha ? { mergeCommit: row.merge_commit_sha } : {}),
    observedAt: iso(row.observed_at),
    observingExecutionId: row.observing_execution_id,
    ownerUserId: row.owner_user_id,
    preview: {
      ...(row.preview_head_sha ? { headCommit: row.preview_head_sha } : {}),
      state: row.preview_state,
    },
    ...(pullRequest ? { pullRequest } : {}),
    review: {
      ...(row.review_checked_at
        ? { checkedAt: iso(row.review_checked_at) }
        : {}),
      ...(row.review_commit_sha ? { commit: row.review_commit_sha } : {}),
      ...(row.review_fingerprint_sha256
        ? { fingerprint: row.review_fingerprint_sha256 }
        : {}),
      ...(row.review_request_fingerprint_sha256
        ? { requestFingerprint: row.review_request_fingerprint_sha256 }
        : {}),
      state: row.review_state,
      ...(row.review_unresolved_threads === null
        ? {}
        : { unresolvedThreads: Number(row.review_unresolved_threads) }),
    },
    revision: Number(row.evidence_revision),
    sourceCommit: row.source_commit_sha,
    taskState: row.task_state,
  };
}

export function mapReview(row: ReviewRow): TaskDeliveryRevisionReview {
  return {
    ...(row.decided_at
      ? {
          decidedAt: iso(row.decided_at),
          decidedBy: { id: row.decided_by_id!, kind: row.decided_by_kind! },
        }
      : {}),
    deliveryId: row.delivery_id,
    evidenceRevision: Number(row.evidence_revision),
    id: row.id,
    ownerUserId: row.owner_user_id,
    pullRequestHeadCommit: row.pull_request_head_sha,
    pullRequestNumber: Number(row.pull_request_number),
    requestedAt: iso(row.requested_at),
    requestedBy: { id: row.requested_by_id, kind: row.requested_by_kind },
    state: row.state,
    summaryFingerprint: row.summary_fingerprint_sha256,
  };
}

export function deliveryValues(input: TaskDeliveryRecord) {
  return [
    input.id,
    input.ownerUserId,
    input.originExecutionId,
    input.providerKind,
    input.repositoryId,
    input.taskId,
    input.branch,
    input.pullRequestNumber ?? null,
    input.policy.kind,
    input.policy.kind === "deployed_healthy"
      ? input.policy.deploymentEnvironment
      : null,
    input.version,
    input.createdAt,
    input.updatedAt,
  ];
}

export function evidenceValues(input: TaskDeliveryEvidence, revision: number) {
  const pr = input.pullRequest;
  const deployment = input.deployment;
  return [
    input.deliveryId,
    input.ownerUserId,
    revision,
    input.observingExecutionId,
    input.sourceCommit,
    input.taskState,
    pr?.number ?? null,
    pr?.baseBranch ?? null,
    pr?.headCommit ?? null,
    pr?.state ?? null,
    pr?.draft ?? null,
    input.checks.state,
    input.checks.fingerprint ?? null,
    input.checks.commit,
    JSON.stringify(input.checks.required),
    input.review.state,
    input.review.commit ?? null,
    input.review.fingerprint ?? null,
    input.review.requestFingerprint ?? null,
    input.review.unresolvedThreads ?? null,
    input.review.checkedAt ?? null,
    input.preview.state,
    input.preview.headCommit ?? null,
    input.mergeCommit ?? null,
    deployment?.environment ?? null,
    deployment?.deployedCommit ?? null,
    deployment?.runningVersion ?? null,
    deployment?.health ?? null,
    deployment?.originReachable ?? null,
    deployment?.originFingerprint ?? null,
    input.fingerprint,
    input.observedAt,
  ];
}

export function reviewRequestValues(input: TaskDeliveryRevisionReview) {
  return [
    input.id,
    input.deliveryId,
    input.ownerUserId,
    input.pullRequestNumber,
    input.pullRequestHeadCommit,
    input.evidenceRevision,
    input.summaryFingerprint,
    input.requestedBy.kind,
    input.requestedBy.id,
    input.requestedAt,
  ];
}

export function sameDelivery(
  left: TaskDeliveryRecord,
  right: TaskDeliveryRecord,
) {
  return (
    left.providerKind === right.providerKind &&
    left.repositoryId === right.repositoryId &&
    left.taskId === right.taskId &&
    left.branch === right.branch &&
    left.pullRequestNumber === right.pullRequestNumber &&
    JSON.stringify(left.policy) === JSON.stringify(right.policy)
  );
}

export function sameReviewRequest(
  left: TaskDeliveryRevisionReview,
  right: TaskDeliveryRevisionReview,
) {
  return (
    left.evidenceRevision === right.evidenceRevision &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.pullRequestHeadCommit === right.pullRequestHeadCommit &&
    left.summaryFingerprint === right.summaryFingerprint &&
    left.requestedBy.id === right.requestedBy.id &&
    left.requestedBy.kind === right.requestedBy.kind
  );
}

export function sameReviewDecision(
  left: TaskDeliveryRevisionReview,
  right: {
    decidedAt: string;
    decidedBy: NonNullable<TaskDeliveryRevisionReview["decidedBy"]>;
    reviewId: string;
    state: "approved" | "rejected";
  },
) {
  return (
    left.id === right.reviewId &&
    left.state === right.state &&
    left.decidedAt === right.decidedAt &&
    left.decidedBy?.id === right.decidedBy.id &&
    left.decidedBy.kind === right.decidedBy.kind
  );
}

export function pullRequestCollision(
  left: TaskDeliveryRecord,
  right: TaskDeliveryRecord,
) {
  return (
    right.pullRequestNumber !== undefined &&
    left.ownerUserId === right.ownerUserId &&
    left.providerKind === right.providerKind &&
    left.repositoryId === right.repositoryId &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.id !== right.id
  );
}

export function assertDelivery(input: TaskDeliveryRecord) {
  if (
    !uuid.test(input.id) ||
    !uuid.test(input.originExecutionId) ||
    !nonBlank(input.ownerUserId) ||
    !bounded(input.providerKind, 80) ||
    !bounded(input.repositoryId, 512) ||
    !bounded(input.taskId, 512) ||
    !bounded(input.branch, 256) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    (input.pullRequestNumber !== undefined &&
      (!Number.isSafeInteger(input.pullRequestNumber) ||
        input.pullRequestNumber < 1)) ||
    !validTimestamp(input.createdAt) ||
    !validTimestamp(input.updatedAt) ||
    (input.policy.kind === "deployed_healthy" &&
      !bounded(input.policy.deploymentEnvironment, 80))
  ) {
    throw new Error("Task delivery is invalid.");
  }
}

export function assertEvidence(input: Omit<TaskDeliveryEvidence, "revision">) {
  const commitValues = [
    input.sourceCommit,
    input.checks.commit,
    input.pullRequest?.headCommit,
    input.preview.headCommit,
    input.mergeCommit,
    input.deployment?.deployedCommit,
  ];
  if (
    !uuid.test(input.deliveryId) ||
    !uuid.test(input.observingExecutionId) ||
    !nonBlank(input.ownerUserId) ||
    !sha256.test(input.fingerprint) ||
    commitValues.some((value) => value !== undefined && !sha.test(value)) ||
    !validTimestamp(input.observedAt) ||
    input.checks.required.length > 100 ||
    (input.checks.state === "unavailable") ===
      Boolean(input.checks.fingerprint) ||
    (input.checks.fingerprint !== undefined &&
      !sha256.test(input.checks.fingerprint)) ||
    (input.review.requestFingerprint !== undefined &&
      !sha256.test(input.review.requestFingerprint)) ||
    (input.review.unresolvedThreads !== undefined &&
      (!Number.isSafeInteger(input.review.unresolvedThreads) ||
        input.review.unresolvedThreads < 0 ||
        input.review.unresolvedThreads > 1_000)) ||
    (input.preview.state === "unavailable") ===
      Boolean(input.preview.headCommit) ||
    (input.deployment &&
      (!bounded(input.deployment.environment, 80) ||
        !sha256.test(input.deployment.originFingerprint) ||
        (input.deployment.runningVersion !== undefined &&
          !bounded(input.deployment.runningVersion, 128)))) ||
    input.checks.required.some(
      (check) =>
        !safeRequiredCheck(check) || check.commit !== input.checks.commit,
    ) ||
    (input.review.state === "unavailable"
      ? Boolean(
          input.review.commit ||
          input.review.fingerprint ||
          input.review.requestFingerprint ||
          input.review.unresolvedThreads !== undefined ||
          input.review.checkedAt,
        )
      : input.review.commit !== input.checks.commit ||
        !input.review.checkedAt ||
        !validTimestamp(input.review.checkedAt) ||
        !sha256.test(input.review.fingerprint ?? "")) ||
    (input.pullRequest &&
      (!Number.isSafeInteger(input.pullRequest.number) ||
        input.pullRequest.number < 1 ||
        !bounded(input.pullRequest.baseBranch, 256)))
  ) {
    throw new Error("Task delivery evidence is invalid.");
  }
}

export function assertReview(input: TaskDeliveryRevisionReview) {
  if (
    !uuid.test(input.id) ||
    input.state !== "requested" ||
    input.decidedAt ||
    input.decidedBy ||
    !sha.test(input.pullRequestHeadCommit) ||
    !/^[0-9a-f]{64}$/.test(input.summaryFingerprint)
  ) {
    throw new Error("Task delivery review is invalid.");
  }
}

function mapRequiredChecks(value: unknown): TaskDeliveryRequiredCheck[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((entry) => !safeRequiredCheck(entry))
  ) {
    throw new Error("Stored Task delivery checks are invalid.");
  }
  return clone(value as TaskDeliveryRequiredCheck[]);
}

function safeRequiredCheck(value: unknown): value is TaskDeliveryRequiredCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const check = value as Record<string, unknown>;
  const keys = Object.keys(check).sort().join(",");
  return (
    (keys === "checkedAt,commit,id,name,state" ||
      keys === "checkedAt,commit,id,name,requiredAppId,state") &&
    typeof check.id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(check.id) &&
    typeof check.name === "string" &&
    check.name.trim().length > 0 &&
    check.name.length <= 256 &&
    typeof check.commit === "string" &&
    sha.test(check.commit) &&
    typeof check.checkedAt === "string" &&
    Number.isFinite(Date.parse(check.checkedAt)) &&
    (check.requiredAppId === undefined ||
      (Number.isSafeInteger(check.requiredAppId) &&
        Number(check.requiredAppId) > 0)) &&
    ["failing", "passing", "pending"].includes(String(check.state))
  );
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const nonBlank = (value: string) => value.trim().length > 0;
const bounded = (value: string, limit: number) =>
  value.trim().length > 0 && value.length <= limit;
const validTimestamp = (value: string) => Number.isFinite(Date.parse(value));
export const targetKey = (owner: string, target: TaskDeliveryProviderTarget) =>
  `${owner}\0${target.providerKind}\0${target.repositoryId}\0${target.taskId}\0${target.branch}`;
export const evidenceKey = (owner: string, delivery: string) =>
  `${owner}\0${delivery}`;
export const reviewKey = (owner: string, delivery: string, head: string) =>
  `${owner}\0${delivery}\0${head}`;
const iso = (value: Date | string) => new Date(value).toISOString();
export const clone = <Value>(value: Value): Value => structuredClone(value);
