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

function loadTasks() {
  if (typeof window === "undefined") return initialMockTasks;
  try {
    const saved = window.sessionStorage.getItem(storageKey);
    return saved ? JSON.parse(saved) as MockTask[] : initialMockTasks;
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
