import { basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  CODEX_HOST_INVENTORY_API_VERSION,
  type CodexHostInventoryResult
} from '../src/shared/codex-host-inventory-api';
import type { DatabaseQueryClient } from './database/client';
import { getCurrentAuthSession, isProjectSpaceAuthRequired } from './local-auth-store';
import { getCodexSessionsDatabaseClient, isDatabaseConfigured } from './local-database-store';
import { writeJson } from './project-space-http-response';
import { tailscaleDeploymentInventoryScope } from './tailscale-inventory/deployment-scope';

const route = '/api/codex/hosts';

interface HostRow {
  addresses: unknown;
  device_id: string;
  machine_id: string;
  machine_name: string;
  worktrees: unknown;
}

interface WorktreeRow {
  path: unknown;
  threadCount: unknown;
}

export function createCodexHostInventoryService(
  client: DatabaseQueryClient,
  now: () => Date = () => new Date()
) {
  return {
    async list(userId: string): Promise<CodexHostInventoryResult> {
      const result = await client.query<HostRow>(`
        select identity.id as machine_id,
               identity.name as machine_name,
               device.device_id,
               array(
                 select host(address)
                   from unnest(device.addresses) address
                  order by host(address)
               ) as addresses,
               coalesce((
                 select jsonb_agg(jsonb_build_object(
                   'path', worktree.cwd,
                   'threadCount', worktree.thread_count
                 ) order by worktree.latest_activity desc, worktree.cwd)
                   from (
                     select snapshot.snapshot ->> 'cwd' as cwd,
                            count(*)::int as thread_count,
                            max(snapshot.last_activity_at) as latest_activity
                       from codex_session_snapshots snapshot
                      where snapshot.owner_user_id = membership.user_id
                        and snapshot.machine_id = membership.machine_id
                        and nullif(snapshot.snapshot ->> 'cwd', '') is not null
                        and coalesce((snapshot.snapshot ->> 'archived')::boolean, false) = false
                      group by snapshot.snapshot ->> 'cwd'
                   ) worktree
               ), '[]'::jsonb) as worktrees
          from machine_memberships membership
          join machine_identities identity
            on identity.id = membership.machine_id
           and identity.owner_user_id = membership.user_id
          cross join lateral (
            select observation.device_id, observation.addresses
              from tailscale_device_observations observation
             where observation.owner_user_id = $2
               and observation.online = true
               and observation.inventory_state = 'current'
               and observation.fresh_until > now()
               and regexp_replace(
                     lower(observation.observed_name),
                     '\\.tail[a-z0-9]+\\.ts\\.net$',
                     ''
                   ) = any(array[
                     lower(identity.name),
                     lower(split_part(identity.hostname, '.', 1))
                   ])
             order by observation.observed_at desc, observation.device_id
             limit 1
          ) device
         where membership.user_id = $1
         order by lower(identity.name), identity.id
      `, [userId, tailscaleDeploymentInventoryScope]);
      return {
        apiVersion: CODEX_HOST_INVENTORY_API_VERSION,
        checkedAt: now().toISOString(),
        hosts: result.rows.map((row) => ({
          addresses: stringArray(row.addresses),
          machineId: row.machine_id,
          name: row.machine_name,
          tailscaleDeviceId: row.device_id,
          worktrees: worktreeRows(row.worktrees).map((worktree) => ({
            label: basename(worktree.path) || worktree.path,
            path: worktree.path,
            threadCount: worktree.threadCount
          }))
        }))
      };
    }
  };
}

export function createConfiguredCodexHostInventoryHandler() {
  let service: ReturnType<typeof createCodexHostInventoryService> | undefined;
  return async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (url.pathname !== route) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    if (request.method !== 'GET' || [...url.searchParams.keys()].length > 0) {
      writeJson(response, request.method === 'GET' ? 400 : 405, {
        error: { code: 'invalid_request', message: 'The Codex host request is invalid.' }
      });
      return true;
    }
    const userId = getCurrentAuthSession()?.userId ?? (
      isProjectSpaceAuthRequired() ? undefined : 'local-development-user'
    );
    if (!userId) {
      writeJson(response, 401, { error: { code: 'login_required', message: 'Login required.' } });
      return true;
    }
    if (!isDatabaseConfigured()) {
      writeJson(response, 503, {
        error: { code: 'codex_hosts_unavailable', message: 'Codex hosts are temporarily unavailable.' }
      });
      return true;
    }
    try {
      service ??= createCodexHostInventoryService(await getCodexSessionsDatabaseClient());
      writeJson(response, 200, await service.list(userId));
    } catch {
      service = undefined;
      writeJson(response, 503, {
        error: { code: 'codex_hosts_unavailable', message: 'Codex hosts are temporarily unavailable.' }
      });
    }
    return true;
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function worktreeRows(value: unknown): Array<{ path: string; threadCount: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as WorktreeRow;
    const path = typeof row.path === 'string' ? row.path : '';
    const threadCount = Number(row.threadCount);
    return path && path.length <= 4096 && Number.isSafeInteger(threadCount) && threadCount >= 0
      ? [{ path, threadCount }]
      : [];
  });
}
