import type { MockTask } from "./task-model";

const eventName = "project-space:mock-task-review-context";

export function publishMockTaskReviewContext(task: MockTask | null) {
  window.dispatchEvent(new CustomEvent<MockTask | null>(eventName, { detail: task }));
}

export function subscribeMockTaskReviewContext(listener: (task: MockTask | null) => void) {
  const handler = (event: Event) => listener((event as CustomEvent<MockTask | null>).detail);
  window.addEventListener(eventName, handler);
  return () => window.removeEventListener(eventName, handler);
}
