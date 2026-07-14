import type { MachineRecord } from '../../../shared/project-space-api';

export function isDevelopmentConnector(
  machine?: Pick<MachineRecord, 'connector' | 'name'>
) {
  return machine?.connector.runtime?.channel === 'dev';
}
