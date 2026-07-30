import { connectAsync } from 'mqtt';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const credentials = input.trim()
  ? JSON.parse(input)
  : {
      password: process.env.MQTT_VERIFY_PASSWORD,
      topicPrefix: process.env.MQTT_VERIFY_TOPIC_PREFIX,
      username: process.env.MQTT_VERIFY_USERNAME
    };
if (typeof credentials.username !== 'string' ||
    typeof credentials.password !== 'string' ||
    typeof credentials.topicPrefix !== 'string' ||
    !/^project-space\/jetkvm\/jetkvm-[A-Za-z0-9._-]+$/.test(credentials.topicPrefix)) {
  throw new Error('Expected exact MQTT credentials and topic prefix on standard input.');
}

const client = await connectAsync(process.env.MQTT_VERIFY_BROKER ?? 'mqtt://127.0.0.1:1883', {
  connectTimeout: 5_000,
  password: credentials.password,
  protocolVersion: 5,
  reconnectPeriod: 0,
  username: credentials.username
});
try {
  const allowed = await client.subscribeAsync([
    `${credentials.topicPrefix}/status`,
    `${credentials.topicPrefix}/atx/state`,
    `${credentials.topicPrefix}/update/state`
  ], { qos: 1 });
  if (allowed.length !== 3 || allowed.some((subscription) => subscription.qos === 128)) {
    throw new Error('The MQTT evidence subscriptions were not authorized.');
  }
  console.log(
    'authenticated=true exactDeviceOnly=true allowedStatusRead=true ' +
      'allowedPhysicalPowerRead=true allowedFirmwareRead=true'
  );
} finally {
  await client.endAsync();
}
