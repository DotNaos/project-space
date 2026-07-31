import { describe, expect, test } from 'bun:test';

import {
  isPhysicalMachineId,
  parsePhysicalMachineSaveRequest
} from '../server/physical-machine-validation';

describe('physical machine request validation', () => {
  test('accepts and normalizes a bounded explicit connector mapping', () => {
    expect(parsePhysicalMachineSaveRequest({
      connectorIds: [' windows ', 'windows', 'wsl-dev'],
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'virtual',
      name: ' os-pc '
    })).toEqual({
      connectorIds: ['windows', 'wsl-dev'],
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'virtual',
      name: 'os-pc'
    });
  });

  test('rejects malformed payloads and IDs that the delete route cannot address', () => {
    expect(parsePhysicalMachineSaveRequest({})).toBeUndefined();
    expect(parsePhysicalMachineSaveRequest({ connectorIds: [], name: 'os-pc' })).toBeUndefined();
    expect(parsePhysicalMachineSaveRequest({ connectorIds: [], kind: 'container', name: 'os-pc' })).toBeUndefined();
    expect(parsePhysicalMachineSaveRequest({
      connectorIds: ['windows'],
      id: '00000000-0000-0000-0000-000000000000',
      kind: 'physical',
      name: 'os-pc'
    })).toBeUndefined();
    expect(isPhysicalMachineId('11111111-1111-7111-8111-111111111111')).toBe(false);
  });

  test('accepts a machine before it has a connector installation', () => {
    expect(parsePhysicalMachineSaveRequest({
      connectorIds: [],
      kind: 'virtual',
      name: 'ChatGPT-Work-VM'
    })).toEqual({
      connectorIds: [],
      id: undefined,
      kind: 'virtual',
      name: 'ChatGPT-Work-VM'
    });
  });
});
