import { describe, expect, test } from 'bun:test';

import {
  parseWorkflowRunRoute,
  workflowRunRouteSuffix
} from '../src/features/project-desktop/hooks/project-route-model';

describe('workflow run routes', () => {
  test('writes and parses a direct internal workflow run URL', () => {
    expect(workflowRunRouteSuffix('123456')).toBe('deployments/runs/123456');
    expect(parseWorkflowRunRoute('deployments', 'runs', '123456')).toBe(123456);
  });

  test('keeps malformed and non-positive run ids on the Deployments overview', () => {
    expect(parseWorkflowRunRoute('deployments', 'runs', 'nope')).toBeUndefined();
    expect(parseWorkflowRunRoute('deployments', 'runs', '-1')).toBeUndefined();
  });

  test('writes the Deployments overview route when detail is cleared', () => {
    expect(workflowRunRouteSuffix()).toBe('deployments');
  });
});
