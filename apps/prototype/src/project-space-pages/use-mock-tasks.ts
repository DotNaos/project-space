import { useEffect, useState } from "react";

import {
  createMockTask,
  initialMockTasks,
  updateMockTask,
  type MockTask,
  type MockTaskAction,
  type MockTaskType,
} from "./task-model";

const storageKey = "project-space-prototype-tasks-v2";

function hydrateFixtureDevelopmentContext(task: MockTask) {
  const fixture = initialMockTasks.find((candidate) => candidate.number === task.number);
  const started = !["issue", "branch"].includes(task.stage);
  const inferredWorkspace = started && task.branch ? {
    changedFiles: 0,
    devServer: { status: "running" as const, transport: "Tailscale" as const },
    machine: task.agentRun?.machine ?? "Local",
    status: "clean" as const,
  } : undefined;
  const inferredThreads = task.agentRun ? [{
    id: `${task.number}-build`,
    machine: task.agentRun.machine,
    name: task.agentRun.name,
    status: task.agentRun.status === "running" ? "running" as const : "idle" as const,
  }] : undefined;

  if (!fixture) return {
    ...task,
    agentThreads: task.agentThreads ?? inferredThreads,
    workspace: task.workspace ?? inferredWorkspace,
  };

  return {
    ...task,
    agentThreads: task.agentThreads && fixture.agentThreads
      ? [...task.agentThreads, ...fixture.agentThreads.filter((thread) => !task.agentThreads?.some((saved) => saved.id === thread.id))]
      : task.agentThreads ?? fixture.agentThreads,
    cleanup: task.cleanup ?? fixture.cleanup,
    workspace: task.workspace && fixture.workspace
      ? {
          ...task.workspace,
          devServer: task.workspace.devServer ?? fixture.workspace.devServer,
        }
      : task.workspace ?? fixture.workspace,
  };
}

function loadTasks() {
  if (typeof window === "undefined") return initialMockTasks;
  try {
    const saved = window.sessionStorage.getItem(storageKey);
    return saved
      ? (JSON.parse(saved) as MockTask[]).map(hydrateFixtureDevelopmentContext)
      : initialMockTasks;
  } catch {
    return initialMockTasks;
  }
}

export function useMockTasks() {
  const [tasks, setTasks] = useState<MockTask[]>(loadTasks);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(tasks));
    } catch {
      // The prototype still works when storage is unavailable.
    }
  }, [tasks]);

  function createTask(input: {
    body: string;
    labels: string[];
    title: string;
    type: MockTaskType;
  }) {
    const nextNumber = Math.max(...tasks.map((task) => task.number), 437) + 1;
    const task = createMockTask({ ...input, number: nextNumber });
    setTasks((current) => [task, ...current]);
    return task;
  }

  function dispatchTask(number: number, action: MockTaskAction) {
    setTasks((current) => current.map((task) => (
      task.number === number ? updateMockTask(task, action) : task
    )));
  }

  function resetTasks() {
    setTasks(initialMockTasks);
  }

  return { createTask, dispatchTask, resetTasks, tasks };
}
