import { describe, expect, test } from "bun:test";

import {
  createMockTask,
  mockTaskGroup,
  updateMockTask,
  type MockTask,
  type MockTaskAction,
} from "../apps/prototype/src/project-space-pages/task-model";

function apply(task: MockTask, ...actions: MockTaskAction[]) {
  return actions.reduce(updateMockTask, task);
}

describe("mocked Task lifecycle", () => {
  test("moves a new Task through the complete delivery workflow", () => {
    let task = createMockTask({
      body: "Use the full Task workflow without touching external systems.",
      labels: ["prototype"],
      number: 500,
      title: "Dogfood the Task lifecycle",
      type: "Feature",
    });

    expect(task.isMockOnly).toBe(true);

    task = apply(
      task,
      { type: "create-branch" },
      { type: "start-development" },
      { type: "open-pull-request" },
      { type: "run-checks" },
      { type: "pass-checks" },
      { type: "start-preview" },
      { type: "request-review" },
      { type: "approve-revision" },
      { type: "merge" },
      { type: "start-deployment" },
      { type: "complete-deployment" },
    );

    expect(task.stage).toBe("deployed");
    expect(task.branchRelation).toBe("1 ahead · 0 behind main");
    expect(task.pullRequest).toMatchObject({ checks: "passed", preview: "ready", review: "approved" });
    expect(task.deployment).toMatchObject({ status: "deployed", url: "https://projects.os-home.net" });
    expect(mockTaskGroup(task)).toBe("Done");
    expect(task.events.at(-1)?.title).toBe("Deployment verified");
  });

  test("supports failed-check recovery and comments", () => {
    let task = createMockTask({ body: "Recover clearly.", labels: [], number: 501, title: "Recover checks", type: "Bug" });
    task = apply(
      task,
      { type: "create-branch" },
      { type: "start-development" },
      { type: "open-pull-request" },
      { type: "run-checks" },
      { type: "fail-checks" },
      { body: "I can see what failed.", type: "add-comment" },
    );

    expect(mockTaskGroup(task)).toBe("Needs you");
    expect(task.comments.at(-1)?.body).toBe("I can see what failed.");

    task = apply(task, { type: "run-checks" }, { type: "pass-checks" });
    expect(task.pullRequest?.checks).toBe("passed");
    expect(mockTaskGroup(task)).toBe("Active");
  });

  test("invalidates approval when the mocked revision changes", () => {
    let task = createMockTask({ body: "Pin approval.", labels: [], number: 502, title: "Protect approval", type: "Feature" });
    task = apply(
      task,
      { type: "create-branch" },
      { type: "start-development" },
      { type: "open-pull-request" },
      { type: "run-checks" },
      { type: "pass-checks" },
      { type: "start-preview" },
      { type: "request-review" },
      { type: "approve-revision" },
    );
    const approvedRevision = task.pullRequest?.revision;

    task = updateMockTask(task, { type: "change-revision" });

    expect(task.pullRequest?.revision).not.toBe(approvedRevision);
    expect(task.pullRequest).toMatchObject({ checks: "not-started", preview: "not-started", review: "not-requested" });
    expect(updateMockTask(task, { type: "merge" }).stage).toBe("pull-request");
  });

  test("recovers an unavailable Preview", () => {
    const task = createMockTask({ body: "Retry Preview.", labels: [], number: 503, title: "Preview recovery", type: "Idea" });
    const withUnavailablePreview: MockTask = {
      ...task,
      branch: "task-503-preview-recovery",
      pullRequest: { checks: "passed", number: 504, preview: "unavailable", review: "not-requested", revision: "dc6bd80" },
      stage: "checks",
    };

    expect(mockTaskGroup(withUnavailablePreview)).toBe("Needs you");
    expect(updateMockTask(withUnavailablePreview, { type: "retry-preview" }).pullRequest?.preview).toBe("ready");
  });
});
