import type { ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { legacyConnectorRetirement } from '../legacy-connector-retirement';
import { writeJson } from '../project-space-http-response';

export { legacyConnectorRetirement };

export function retireCodexHttp(response: ServerResponse) {
  response.setHeader('Cache-Control', 'no-store');
  writeJson(response, 410, legacyConnectorRetirement);
}

export function retireCodexUpgrade(socket: Duplex) {
  const body = JSON.stringify(legacyConnectorRetirement);
  socket.end([
    'HTTP/1.1 410 Gone',
    'Connection: close',
    'Cache-Control: no-store',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n'));
}
