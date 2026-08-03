import { describe, expect, test } from "bun:test";

import { suggestTaskTitle } from "../apps/prototype/src/project-space-pages/new-task";
import { nextTaskAction } from "../apps/prototype/src/project-space-pages/task-lifecycle-panel";
import {
  createMockTask,
  initialMockTasks,
  updateMockTask,
  type MockTask,
} from "../apps/prototype/src/project-space-pages/task-model";

function runNext(task: MockTask) {
  const next = nextTaskAction(task);
  expect(next).not.toBeNull();
  return updateMockTask(task, next!.action);
}

describe("prototype task lifecycle", () => {
  test("moves from a new Task through approval, merge, deployment, and cleanup", () => {
    let task = createMockTask({
      body: "Build the complete lifecycle so it can be dogfooded before infrastructure exists.",
      labels: ["prototype"],
      number: 438,
      title: "Dogfood the complete Task lifecycle",
      type: "Feature",
    });

    task = runNext(task);
    expect(task.stage).toBe("branch");
    task = runNext(task);
    expect(task.workspace?.devServer?.status).toBe("running");
    expect(task.agentThreads?.[0]?.status).toBe("running");
    task = runNext(task);
    expect(task.pullRequest?.phase).toBe("draft");
    expect(nextTaskAction(task)?.label).toBe("Mark PR ready");
    task = runNext(task);
    task = runNext(task);
    task = runNext(task);
    task = runNext(task);
    expect(task.pullRequest?.preview).toBe("ready");
    expect(nextTaskAction(task)?.label).toBe("Approve revision");
    task = runNext(task);
    expect(task.pullRequest?.review).toBe("approved");
    task = runNext(task);
    expect(task.stage).toBe("merged");
    expect(task.cleanup?.remoteBranch).toBe("exists");
    task = runNext(task);
    task = runNext(task);
    expect(task.stage).toBe("deployed");

    task = updateMockTask(task, { type: "delete-remote-branch" });
    task = updateMockTask(task, { machine: "Local", type: "remove-worktree" });
    expect(task.cleanup).toEqual({ remoteBranch: "deleted", worktrees: [] });
  });

  test("does not remove a modified worktree", () => {
    const completed = initialMockTasks.find((task) => task.number === 434)!;
    const next = updateMockTask(completed, { machine: "os-macbook", type: "remove-worktree" });
    expect(next).toBe(completed);
  });

  test("suggests a short title while preserving the full idea for the description", () => {
    expect(suggestTaskTitle("Add task notifications. They should appear after the agent finishes."))
      .toBe("Add task notifications");
    expect(suggestTaskTitle("Build a deliberately long title that should stop at a word boundary instead of cutting the final word apart for users"))
      .toBe("Build a deliberately long title that should stop at a word boundary");
  });
});
