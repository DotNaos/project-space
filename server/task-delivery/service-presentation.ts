import type { TaskDeliveryRecord } from './contracts';

export function generatedTaskDeliveryPresentation(
  objective: string,
  delivery: TaskDeliveryRecord,
  head: string
) {
  return {
    body: `Implements ${delivery.taskId}.\n\nExecution: ${delivery.originExecutionId}\nCommit: ${head}`,
    title: objective.trim().slice(0, 1_000) || `Complete ${delivery.taskId}`
  };
}
