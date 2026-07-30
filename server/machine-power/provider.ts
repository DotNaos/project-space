import { randomUUID } from 'node:crypto';

import { connectAsync, type IClientOptions, type MqttClient } from 'mqtt';

import type { MachinePowerEvidence } from '../../src/shared/machine-power-api';
import {
  projectCredentialEnvironment,
  type JetKvmMqttBinding
} from './config';

const probeTimeoutMs = 18_000;

export interface MachinePowerProvider {
  probe(binding: JetKvmMqttBinding): Promise<MachinePowerEvidence>;
  requestPowerOn(binding: JetKvmMqttBinding): Promise<{
    attempted: boolean;
    evidence: MachinePowerEvidence;
  }>;
}

export class MachinePowerProviderError extends Error {
  constructor(readonly stage: 'delivery' | 'preflight') {
    super(stage === 'delivery'
      ? 'Machine power delivery is uncertain.'
      : 'Machine power preflight failed.');
    this.name = 'MachinePowerProviderError';
  }
}

export function createJetKvmMqttProvider(
  environment: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now
): MachinePowerProvider {
  async function connect(binding: JetKvmMqttBinding) {
    const { password, username } = resolveProjectMqttCredential(binding, environment);
    const options: IClientOptions = {
      clean: true,
      clientId: `project-space-power-${randomUUID()}`,
      connectTimeout: 5_000,
      password,
      reconnectPeriod: 0,
      rejectUnauthorized: true,
      username
    };
    return connectAsync(binding.provider.broker, options);
  }

  return {
    async probe(binding) {
      const client = await connect(binding);
      try {
        return await collectMachinePowerEvidence(
          client, binding.provider.topicPrefix, now
        );
      } finally {
        await client.endAsync();
      }
    },

    async requestPowerOn(binding) {
      let client: MqttClient;
      try {
        client = await connect(binding);
      } catch {
        throw new MachinePowerProviderError('preflight');
      }
      try {
        let evidence;
        try {
          evidence = await collectMachinePowerEvidence(
            client, binding.provider.topicPrefix, now
          );
        } catch {
          throw new MachinePowerProviderError('preflight');
        }
        if (!evidence.fresh || evidence.jetKvmOnline !== true ||
            evidence.physicalPower !== false ||
            !firmwareMatches(binding.provider.firmwareCompatibility, evidence.firmwareVersion)) {
          return { attempted: false, evidence };
        }
        if (!client.connected) throw new Error('Machine power broker is not connected.');
        try {
          await client.publishAsync(
            `${binding.provider.topicPrefix}/atx_power_short/set`,
            'PRESS',
            { qos: 0, retain: false }
          );
        } catch {
          throw new MachinePowerProviderError('delivery');
        }
        return { attempted: true, evidence };
      } catch (error) {
        if (error instanceof MachinePowerProviderError) throw error;
        throw new MachinePowerProviderError('delivery');
      } finally {
        await client.endAsync().catch(() => undefined);
      }
    }
  };
}

export function resolveProjectMqttCredential(
  binding: JetKvmMqttBinding,
  environment: NodeJS.ProcessEnv
) {
  const names = projectCredentialEnvironment(binding);
  const username = environment[names.username];
  const password = environment[names.password];
  if (!username || !password) {
    throw new Error('Machine power broker credentials are not configured.');
  }
  if (username !== binding.provider.projectCredential.expectedUsername) {
    throw new Error('Machine power broker credential identity does not match the provider.');
  }
  return { password, username };
}

export async function collectMachinePowerEvidence(
  client: MqttClient,
  prefix: string,
  now: () => number,
  timeoutMs = probeTimeoutMs
): Promise<MachinePowerEvidence> {
  let firmwareVersion: string | undefined;
  let jetKvmOnline: boolean | undefined;
  let physicalPower: boolean | undefined;
  let liveStatus = false;
  const statusTopic = `${prefix}/status`;
  const powerTopic = `${prefix}/atx/state`;
  const updateTopic = `${prefix}/update/state`;

  const complete = new Promise<void>((resolveComplete) => {
    const finish = () => {
      if (liveStatus && jetKvmOnline === true && physicalPower !== undefined &&
          firmwareVersion !== undefined) resolveComplete();
    };
    client.on('message', (receivedTopic, payload, packet) => {
      try {
        const value = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
        if (receivedTopic === statusTopic && typeof value.online === 'boolean') {
          jetKvmOnline = value.online;
          if (!packet.retain) liveStatus = true;
        }
        if (receivedTopic === powerTopic && typeof value.power === 'boolean') {
          physicalPower = value.power;
        }
        if (receivedTopic === updateTopic &&
            typeof value.installed_version === 'string' &&
            value.installed_version.trim()) {
          firmwareVersion = value.installed_version.trim();
        }
        finish();
      } catch {
        // Invalid retained evidence stays unknown.
      }
    });
  });
  await client.subscribeAsync([statusTopic, powerTopic, updateTopic], { qos: 1 });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      complete,
      new Promise<void>((resolveTimeout) => {
        timeout = setTimeout(resolveTimeout, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const checkedAt = new Date(now()).toISOString();
  return {
    checkedAt,
    fresh: liveStatus,
    ...(firmwareVersion === undefined ? {} : { firmwareVersion }),
    ...(jetKvmOnline === undefined ? {} : { jetKvmOnline }),
    ...(physicalPower === undefined ? {} : { physicalPower }),
    source: 'jetkvm-mqtt'
  };
}

export function firmwareMatches(expected: string, actual: string | undefined) {
  if (!actual) return false;
  return expected.replace(/^release\//, '') === actual.replace(/^release\//, '');
}
