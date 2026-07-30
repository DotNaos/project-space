import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { MachinePowerEvidence } from '../../src/shared/machine-power-api';
import type { JetKvmMqttBinding } from './config';
import {
  MachinePowerProviderError,
  type MachinePowerProvider
} from './provider';
import { createMachinePowerService } from './service';
import {
  MemoryMachinePowerOperationStore,
  type MachinePowerReservation
} from './store';

const machine = {
  connectorIds: ['connector-os-pc'],
  id: '11111111-1111-4111-8111-111111111111',
  name: 'os-pc'
};

const binding: JetKvmMqttBinding = {
  machine: {
    ownerUserId: 'owner',
    physicalMachineId: '11111111-1111-4111-8111-111111111111',
    selector: 'os-pc'
  },
  provider: {
    broker: 'mqtts://mqtt.os-home.net:8883',
    deviceId: 'b46e1a936ac89a4e',
    firmwareCompatibility: 'release/0.5.8',
    kind: 'jetkvm-mqtt',
    projectCredential: {
      credentialId: 'jetkvm-b46e1a936ac89a4e',
      expectedUsername: 'project-space-jetkvm-b46e1a936ac89a4e'
    },
    topicPrefix: 'project-space/jetkvm/jetkvm-b46e1a936ac89a4e',
    desiredJetKvmSettings: {
      base_topic: 'project-space/jetkvm/jetkvm-b46e1a936ac89a4e',
      broker: 'mqtt.os-home.net',
      debounce_ms: 500,
      enable_actions: true,
      enable_ha_discovery: false,
      enabled: true,
      expectedUsername: 'jetkvm-b46e1a936ac89a4e',
      passwordRef: 'op://projects/jetkvm-os-pc-mqtt-client/password',
      port: 8883,
      tls_insecure: false,
      use_tls: true,
      usernameRef: 'op://projects/jetkvm-os-pc-mqtt-client/username'
    }
  },
  provisioning: {
    bootstrapAddress: '192.0.2.1',
    identity: {
      applicationSha256:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      deviceHostname: 'jetkvm-b46e1a936ac89a4e',
      ethernetMac: '00:11:22:33:44:55',
      sshHostKeySha256:
        'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      sshPrivateKeyRef: 'op://test/jetkvm/private_key',
      sshPublicKeyRef: 'op://test/jetkvm/public_key'
    },
    schema: 'project-space.jetkvm-provisioning/v1',
    tailscale: {
      hostname: 'jetkvm-os-pc',
      oauthClientIdRef: 'op://test/tailscale/username',
      oauthClientSecretRef: 'op://test/tailscale/password',
      packageBaseUrl: 'https://pkgs.tailscale.com/stable',
      tag: 'tag:jetkvm',
      version: '1.98.10'
    }
  },
  schema: 'project-space.machine-power-provider/v1'
};

function evidence(physicalPower?: boolean): MachinePowerEvidence {
  return {
    checkedAt: new Date().toISOString(),
    firmwareVersion: '0.5.8',
    fresh: true,
    jetKvmOnline: true,
    ...(physicalPower === undefined ? {} : { physicalPower }),
    source: 'jetkvm-mqtt'
  };
}

function fixture(
  provider: MachinePowerProvider,
  bindings = [binding],
  operations = new MemoryMachinePowerOperationStore()
) {
  return createMachinePowerService({
    bindings: async () => bindings,
    inventory: async () => [machine],
    operations,
    provider
  });
}

describe('machine power service', () => {
  test('records exactly one delivery attempt and replays it safely', async () => {
    let presses = 0;
    const service = fixture({
      probe: async () => evidence(false),
      requestPowerOn: async () => {
        presses += 1;
        return { attempted: true, evidence: evidence(false) };
      }
    });
    const request = {
      operationId: 'machine-power:on:test',
      physicalMachineName: 'os-pc',
      requestedState: 'on' as const
    };

    const first = await service.request({ userId: 'owner' }, request);
    const replay = await service.request({ userId: 'owner' }, request);

    assert.equal(first.state, 'uncertain');
    assert.equal(first.dispatch.attempted, true);
    assert.equal(first.dispatch.brokerAcknowledged, false);
    assert.deepEqual(replay, first);
    assert.equal(presses, 1);
  });

  test('does not toggle when physical power evidence is missing', async () => {
    let presses = 0;
    const service = fixture({
      probe: async () => evidence(),
      requestPowerOn: async () => {
        return { attempted: false, evidence: evidence() };
      }
    });

    const result = await service.request({ userId: 'owner' }, {
      operationId: 'machine-power:on:unknown',
      physicalMachineName: 'os-pc',
      requestedState: 'on'
    });

    assert.equal(result.state, 'uncertain');
    assert.equal(presses, 0);
  });

  test('treats an already powered machine as confirmed without dispatch', async () => {
    let presses = 0;
    const service = fixture({
      probe: async () => evidence(true),
      requestPowerOn: async () => {
        return { attempted: false, evidence: evidence(true) };
      }
    });

    const result = await service.request({ userId: 'owner' }, {
      operationId: 'machine-power:on:already-on',
      physicalMachineName: 'os-pc',
      requestedState: 'on'
    });

    assert.equal(result.state, 'confirmed-online');
    assert.equal(presses, 0);
  });

  test('keeps forced off unsupported and reports missing providers honestly', async () => {
    const provider = {
      probe: async () => evidence(false),
      requestPowerOn: async () => { throw new Error('must not dispatch'); }
    };
    const service = fixture(provider);
    const off = await service.request({ userId: 'owner' }, {
      operationId: 'machine-power:off:test',
      physicalMachineName: 'os-pc',
      requestedState: 'off'
    });
    const unconfigured = await fixture(provider, []).status(
      { userId: 'owner' },
      { physicalMachineName: 'os-pc' }
    );

    assert.equal(off.state, 'unsupported');
    assert.equal(unconfigured.state, 'unsupported');
  });

  test('does not retry when broker delivery is uncertain', async () => {
    let presses = 0;
    const service = fixture({
      probe: async () => evidence(false),
      requestPowerOn: async () => {
        presses += 1;
        throw new Error('connection lost while publishing');
      }
    });
    const request = {
      operationId: 'machine-power:on:uncertain',
      physicalMachineName: 'os-pc',
      requestedState: 'on' as const
    };

    const first = await service.request({ userId: 'owner' }, request);
    const replay = await service.request({ userId: 'owner' }, request);

    assert.equal(first.state, 'uncertain');
    assert.equal(replay.state, 'uncertain');
    assert.equal(presses, 1);
  });

  test('reports a failed preflight separately from uncertain delivery', async () => {
    const service = fixture({
      probe: async () => { throw new Error('offline'); },
      requestPowerOn: async () => { throw new MachinePowerProviderError('preflight'); }
    });

    const result = await service.request({ userId: 'owner' }, {
      operationId: 'machine-power:on:failed-preflight',
      physicalMachineName: 'os-pc',
      requestedState: 'on'
    });

    assert.equal(result.state, 'failed');
    assert.equal(result.dispatch.attempted, false);
  });

  test('fences a different operation ID after an attempted toggle', async () => {
    let attempts = 0;
    const service = fixture({
      probe: async () => evidence(false),
      requestPowerOn: async () => {
        attempts += 1;
        return { attempted: true, evidence: evidence(false) };
      }
    });

    const first = await service.request({ userId: 'owner' }, {
      operationId: 'machine-power:on:first',
      physicalMachineName: 'os-pc',
      requestedState: 'on'
    });
    const fenced = await service.request({ userId: 'owner' }, {
      operationId: 'machine-power:on:second',
      physicalMachineName: 'os-pc',
      requestedState: 'on'
    });

    assert.equal(first.dispatch.attempted, true);
    assert.equal(fenced.state, 'uncertain');
    assert.equal(fenced.dispatch.attempted, false);
    assert.equal(attempts, 1);
  });

  test('fresh online evidence reconciles and releases an attempted toggle fence', async () => {
    let requestEvidence = evidence(false);
    let attempts = 0;
    const service = fixture({
      probe: async () => evidence(true),
      requestPowerOn: async () => {
        attempts += 1;
        return {
          attempted: requestEvidence.physicalPower === false,
          evidence: requestEvidence
        };
      }
    });

    await service.request({ userId: 'owner' }, {
      operationId: 'machine-power:on:first',
      physicalMachineName: 'os-pc',
      requestedState: 'on'
    });
    const status = await service.status(
      { userId: 'owner' },
      { physicalMachineName: 'os-pc' }
    );
    requestEvidence = evidence(true);
    const afterReconciliation = await service.request({ userId: 'owner' }, {
      operationId: 'machine-power:on:second',
      physicalMachineName: 'os-pc',
      requestedState: 'on'
    });

    assert.equal(status.state, 'online');
    assert.equal(afterReconciliation.state, 'confirmed-online');
    assert.equal(attempts, 2);
  });

  test('a preflight uncertainty without a delivery attempt does not fence the machine', async () => {
    let preflights = 0;
    const noPowerEvidence = { ...evidence(), physicalPower: undefined };
    const service = fixture({
      probe: async () => noPowerEvidence,
      requestPowerOn: async () => {
        preflights += 1;
        return { attempted: false, evidence: noPowerEvidence };
      }
    });

    const first = await service.request({ userId: 'owner' }, {
      operationId: 'machine-power:on:first-preflight',
      physicalMachineName: 'os-pc',
      requestedState: 'on'
    });
    const second = await service.request({ userId: 'owner' }, {
      operationId: 'machine-power:on:second-preflight',
      physicalMachineName: 'os-pc',
      requestedState: 'on'
    });

    assert.equal(first.dispatch.attempted, false);
    assert.equal(second.dispatch.attempted, false);
    assert.equal(preflights, 2);
  });

  test('rejects unapproved JetKVM firmware before dispatch', async () => {
    const incompatible = { ...evidence(false), firmwareVersion: '0.6.0' };
    const service = fixture({
      probe: async () => incompatible,
      requestPowerOn: async () => ({ attempted: false, evidence: incompatible })
    });

    const result = await service.request({ userId: 'owner' }, {
      operationId: 'machine-power:on:wrong-firmware',
      physicalMachineName: 'os-pc',
      requestedState: 'on'
    });

    assert.equal(result.state, 'unsupported');
    assert.equal(result.dispatch.attempted, false);
  });

  test('keeps confirmed power truthful when operation reconciliation fails', async () => {
    const operations = new MemoryMachinePowerOperationStore();
    operations.reconcileOnline = async () => {
      throw new Error('database unavailable');
    };
    const service = fixture({
      probe: async () => evidence(true),
      requestPowerOn: async () => ({ attempted: false, evidence: evidence(true) })
    }, [binding], operations);

    const result = await service.status(
      { userId: 'owner' },
      { physicalMachineName: 'os-pc' }
    );

    assert.equal(result.state, 'online');
    assert.equal(result.evidence?.physicalPower, true);
    assert.equal(result.reconciliation?.state, 'failed');
    assert.match(result.message, /reconciliation could not be recorded/);
  });

  test('carries the exact connector caller into the durable reservation', async () => {
    class CapturingStore extends MemoryMachinePowerOperationStore {
      reservation?: MachinePowerReservation;

      override async reserve(input: MachinePowerReservation) {
        this.reservation = structuredClone(input);
        return super.reserve(input);
      }
    }
    const operations = new CapturingStore();
    const service = fixture({
      probe: async () => evidence(true),
      requestPowerOn: async () => ({ attempted: false, evidence: evidence(true) })
    }, [binding], operations);

    await service.request(
      { callerMachineId: 'connector-os-macbook', userId: 'owner' },
      {
        operationId: 'machine-power:on:caller-audit',
        physicalMachineName: 'os-pc',
        requestedState: 'on'
      }
    );

    assert.equal(operations.reservation?.actorType, 'machine');
    assert.equal(operations.reservation?.callerMachineId, 'connector-os-macbook');
  });
});
