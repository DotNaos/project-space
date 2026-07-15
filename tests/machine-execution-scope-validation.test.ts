import { describe, expect, test } from 'bun:test';
import {
  isMachineExecutionScopeId,
  parseMachineExecutionScopeSaveRequest
} from '../server/machine-execution-scope-validation';

describe('machine execution scope request validation', () => {
  test('accepts and normalizes a bounded explicit mapping', () => {
    expect(parseMachineExecutionScopeSaveRequest({
      id: '11111111-1111-4111-8111-111111111111',
      machineIds: [' windows ', 'windows', 'wsl-dev'],
      name: ' os-pc '
    })).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      machineIds: ['windows', 'wsl-dev'],
      name: 'os-pc'
    });
  });

  test('rejects malformed payloads and IDs that the delete route cannot address', () => {
    expect(parseMachineExecutionScopeSaveRequest({})).toBeUndefined();
    expect(parseMachineExecutionScopeSaveRequest({ machineIds: [], name: 'os-pc' })).toBeUndefined();
    expect(parseMachineExecutionScopeSaveRequest({
      id: '00000000-0000-0000-0000-000000000000',
      machineIds: ['windows'],
      name: 'os-pc'
    })).toBeUndefined();
    expect(isMachineExecutionScopeId('11111111-1111-7111-8111-111111111111')).toBe(false);
  });
});
