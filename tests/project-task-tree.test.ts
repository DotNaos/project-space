import { describe, expect, test } from 'bun:test';
import type { ProjectTaskViewModel } from '../src/features/project-tasks/task-view-model';
import { buildProjectTaskTree } from '../src/features/project-tasks/project-task-tree';

function task(number: number, parentNumber?: number): ProjectTaskViewModel {
  return {
    comments: [],
    health: 'unknown',
    issue: {
      labels: [],
      number,
      parentIssue: parentNumber ? {
        number: parentNumber,
        title: `Issue ${parentNumber}`,
        url: `https://github.com/DotNaos/project-space/issues/${parentNumber}`
      } : undefined,
      state: 'open',
      title: `Issue ${number}`,
      url: `https://github.com/DotNaos/project-space/issues/${number}`
    },
    state: 'backlog'
  };
}

describe('project task tree', () => {
  test('nests loaded parent and child issues while keeping missing parents at the root', () => {
    const tree = buildProjectTaskTree([task(2, 1), task(1), task(3, 99)]);

    expect(tree.map((node) => node.task.issue.number)).toEqual([1, 3]);
    expect(tree[0]?.children.map((node) => node.task.issue.number)).toEqual([2]);
  });

  test('breaks cyclic parent metadata without losing tasks', () => {
    const tree = buildProjectTaskTree([task(1, 2), task(2, 1)]);
    const numbers = tree.flatMap((node) => [node.task.issue.number, ...node.children.map((child) => child.task.issue.number)]);

    expect(numbers.sort()).toEqual([1, 2]);
  });
});
