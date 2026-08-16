import type { ProjectTaskViewModel } from './task-view-model';

export interface ProjectTaskTreeNode {
  children: ProjectTaskTreeNode[];
  task: ProjectTaskViewModel;
}

export function buildProjectTaskTree(
  tasks: readonly ProjectTaskViewModel[]
): ProjectTaskTreeNode[] {
  const taskByIssue = new Map(tasks.map((task) => [task.issue.number, task]));
  const parentByIssue = new Map<number, number>();

  for (const task of tasks) {
    const parentNumber = task.issue.parentIssue?.number;
    if (
      parentNumber === undefined
      || parentNumber === task.issue.number
      || !taskByIssue.has(parentNumber)
      || createsCycle(task.issue.number, parentNumber, parentByIssue)
    ) {
      continue;
    }
    parentByIssue.set(task.issue.number, parentNumber);
  }

  const childrenByParent = new Map<number, ProjectTaskViewModel[]>();
  for (const task of tasks) {
    const parentNumber = parentByIssue.get(task.issue.number);
    if (parentNumber === undefined) continue;
    const children = childrenByParent.get(parentNumber) ?? [];
    children.push(task);
    childrenByParent.set(parentNumber, children);
  }

  const buildNode = (task: ProjectTaskViewModel): ProjectTaskTreeNode => ({
    children: (childrenByParent.get(task.issue.number) ?? []).map(buildNode),
    task
  });

  return tasks
    .filter((task) => !parentByIssue.has(task.issue.number))
    .map(buildNode);
}

function createsCycle(
  childNumber: number,
  parentNumber: number,
  parentByIssue: ReadonlyMap<number, number>
) {
  const visited = new Set<number>();
  let current = parentNumber;

  while (!visited.has(current)) {
    if (current === childNumber) return true;
    visited.add(current);
    const next = parentByIssue.get(current);
    if (next === undefined) return false;
    current = next;
  }

  return false;
}
