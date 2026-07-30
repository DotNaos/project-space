import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';

import type { MqttClient } from 'mqtt';

import {
  collectMachinePowerEvidence,
  firmwareMatches
} from './provider';

const prefix = 'project-space/jetkvm/jetkvm-device';

class FakeMqttClient extends EventEmitter {
  subscribedTopics: string[] = [];

  constructor(private readonly publishEvidence: (client: FakeMqttClient) => void) {
    super();
  }

  async subscribeAsync(topics: string[]) {
    this.subscribedTopics = topics;
    this.publishEvidence(this);
    return [];
  }

  message(topic: string, value: unknown, retain: boolean) {
    this.emit('message', topic, Buffer.from(JSON.stringify(value)), { retain });
  }
}

describe('JetKVM MQTT evidence protocol', () => {
  test('requires a live periodic status after the retained snapshot', async () => {
    const client = new FakeMqttClient((mqtt) => {
      mqtt.message(`${prefix}/status`, { online: true }, true);
      mqtt.message(`${prefix}/atx/state`, { power: false }, true);
      mqtt.message(`${prefix}/update/state`, { installed_version: '0.5.8' }, true);
      mqtt.message(`${prefix}/status`, { online: true }, false);
    });

    const result = await collectMachinePowerEvidence(
      client as unknown as MqttClient,
      prefix,
      () => Date.parse('2026-07-29T12:00:00Z'),
      10
    );

    assert.deepEqual(client.subscribedTopics, [
      `${prefix}/status`,
      `${prefix}/atx/state`,
      `${prefix}/update/state`
    ]);
    assert.deepEqual(result, {
      checkedAt: '2026-07-29T12:00:00.000Z',
      firmwareVersion: '0.5.8',
      fresh: true,
      jetKvmOnline: true,
      physicalPower: false,
      source: 'jetkvm-mqtt'
    });
  });

  test('does not call retained evidence fresh', async () => {
    const client = new FakeMqttClient((mqtt) => {
      mqtt.message(`${prefix}/status`, { online: true }, true);
      mqtt.message(`${prefix}/atx/state`, { power: false }, true);
      mqtt.message(`${prefix}/update/state`, { installed_version: '0.5.8' }, true);
    });

    const result = await collectMachinePowerEvidence(
      client as unknown as MqttClient,
      prefix,
      Date.now,
      1
    );

    assert.equal(result.fresh, false);
    assert.equal(result.physicalPower, false);
    assert.equal(result.firmwareVersion, '0.5.8');
  });

  test('matches the version-pinned release without accepting another firmware', () => {
    assert.equal(firmwareMatches('release/0.5.8', '0.5.8'), true);
    assert.equal(firmwareMatches('release/0.5.8', '0.6.0'), false);
    assert.equal(firmwareMatches('release/0.5.8', undefined), false);
  });
});
