import { describe, expect, test } from 'bun:test';

import {
  ConnectorRuntimeMaintenanceAdmission,
  createConnectorRuntimeMaintenanceSafetyCheck
} from '../server/connector-runtime-maintenance-safety';

const idle = { maintenanceBlockers: () => [] };

describe('connector runtime maintenance admission', () => {
  test('an activity reservation wins before maintenance and releases cleanly', () => {
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    const activity = admission.tryBeginActivity('codex');
    expect(activity).toBeDefined();
    const inspect = createConnectorRuntimeMaintenanceSafetyCheck(admission, idle);

    expect(inspect()).toEqual({
      blockers: [{ count: 1, kind: 'connector-activity', scope: 'codex' }],
      certainty: 'known'
    });
    activity?.release();
    const maintenance = inspect();
    expect(maintenance).toMatchObject({ blockers: [], certainty: 'known' });
    expect(maintenance.certainty === 'known' && maintenance.lease).toBeDefined();
    if (maintenance.certainty === 'known') maintenance.lease?.release();
  });

  test('maintenance wins before new activity and a failed inspection never locks admission', () => {
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    const inspect = createConnectorRuntimeMaintenanceSafetyCheck(admission, idle);
    const maintenance = inspect();
    expect(maintenance.certainty === 'known' && maintenance.lease).toBeDefined();
    expect(admission.tryBeginActivity('worktree')).toBeUndefined();
    if (maintenance.certainty === 'known') maintenance.lease?.release();
    const activity = admission.tryBeginActivity('worktree');
    expect(activity).toBeDefined();
    activity?.release();

    const uncertain = createConnectorRuntimeMaintenanceSafetyCheck(admission, {
      maintenanceBlockers() { throw new Error('state unavailable'); }
    });
    expect(uncertain()).toEqual({ certainty: 'uncertain' });
    const afterUncertain = admission.tryBeginActivity('workspace');
    expect(afterUncertain).toBeDefined();
    afterUncertain?.release();
  });
});
