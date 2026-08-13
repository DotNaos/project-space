import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { retireCodexUpgrade } from '../codex-sessions/retirement';
import type { CodexAttachLeaseStore } from './attach-lease-store';

const attachPath = /^\/api\/codex\/tasks\/[^/]+\/attach\/socket$/;

/**
 * The attach endpoint belonged to the retired Connector tunnel. Workspace
 * Runtime sessions use their own authenticated websocket and never reach it.
 */
export function createCodexAttachUpgradeHandler(_leases: CodexAttachLeaseStore) {
  return {
    close() {},
    handleUpgrade(request: IncomingMessage, socket: Duplex, _head: Buffer) {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!attachPath.test(url.pathname)) return false;
      retireCodexUpgrade(socket);
      return true;
    }
  };
}
