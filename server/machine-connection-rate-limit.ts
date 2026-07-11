import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

import type { DatabaseQueryClient } from './database/client';

const acceptedAttemptLimit = 5;
const cleanupBatchSize = 500;
const forwardedHeaderMaximumLength = 2_048;
const forwardedHopLimit = 32;
const rateWindowMilliseconds = 10 * 60 * 1_000;

interface AttemptCountRow {
  accepted_count: number | string;
}

export interface MachineConnectionRateLimiterOptions {
  client: DatabaseQueryClient;
  hmacSecret: Uint8Array;
  now?: () => Date;
}

export interface MachineConnectionRateLimiter {
  allowCreateRequest(request: IncomingMessage): Promise<boolean>;
  cleanupOldEvents(): Promise<number>;
}

interface TransactionalDatabaseQueryClient extends DatabaseQueryClient {
  transaction<Result>(
    operation: (client: DatabaseQueryClient) => Promise<Result>
  ): Promise<Result>;
}

function canonicalIpv6(address: string) {
  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

function mappedIpv4Address(address: string) {
  const match = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const upper = Number.parseInt(match[1], 16);
  const lower = Number.parseInt(match[2], 16);
  return [upper >> 8, upper & 0xff, lower >> 8, lower & 0xff].join('.');
}

function normalizeIpAddress(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const candidate = value.trim();
  if (!candidate || candidate.length > 64 || candidate.includes('%')) {
    return null;
  }

  const version = isIP(candidate);
  if (version === 4) {
    return candidate
      .split('.')
      .map((part) => String(Number(part)))
      .join('.');
  }
  if (version !== 6) {
    return null;
  }

  const canonical = canonicalIpv6(candidate);
  return canonical ? mappedIpv4Address(canonical) ?? canonical : null;
}

function isTrustedProxyAddress(address: string) {
  if (isIP(address) === 4) {
    const [first = -1, second = -1] = address.split('.').map(Number);
    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  if (address === '::1') {
    return true;
  }

  const firstGroup = Number.parseInt(address.split(':')[0] ?? '', 16);
  return (
    (firstGroup & 0xfe00) === 0xfc00 ||
    (firstGroup & 0xffc0) === 0xfe80
  );
}

function rightmostForwardedAddress(header: string | string[] | undefined) {
  if (header === undefined) {
    return null;
  }

  const serialized = Array.isArray(header) ? header.join(',') : header;
  if (serialized.length > forwardedHeaderMaximumLength) {
    return null;
  }

  const hops = serialized.split(',');
  if (hops.length > forwardedHopLimit) {
    return null;
  }

  return normalizeIpAddress(hops[hops.length - 1]);
}

function requesterAddress(request: IncomingMessage) {
  const remoteAddress = normalizeIpAddress(request.socket.remoteAddress);
  if (!remoteAddress) {
    return null;
  }

  if (!isTrustedProxyAddress(remoteAddress)) {
    return remoteAddress;
  }

  return (
    rightmostForwardedAddress(request.headers['x-forwarded-for']) ?? remoteAddress
  );
}

async function runTransaction<Result>(
  client: TransactionalDatabaseQueryClient,
  operation: (transaction: DatabaseQueryClient) => Promise<Result>
) {
  return client.transaction(operation);
}

function transactionalClient(client: DatabaseQueryClient) {
  if (typeof client.transaction !== 'function') {
    throw new Error('The machine connection rate limiter requires transaction support.');
  }

  return client as TransactionalDatabaseQueryClient;
}

function attemptCount(row: AttemptCountRow | undefined) {
  const value = row?.accepted_count;
  const count =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

  if (!Number.isSafeInteger(count) || Number(count) < 0) {
    throw new Error('The machine connection rate count was invalid.');
  }

  return Number(count);
}

function currentTime(now: () => Date) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('The machine connection rate clock was invalid.');
  }
  return new Date(value.getTime());
}

export function createMachineConnectionRateLimiter(
  options: MachineConnectionRateLimiterOptions
): MachineConnectionRateLimiter {
  if (!(options.hmacSecret instanceof Uint8Array) || options.hmacSecret.byteLength < 32) {
    throw new Error('The machine connection rate secret must contain at least 32 bytes.');
  }

  const client = transactionalClient(options.client);
  const hmacSecret = Buffer.from(options.hmacSecret);
  const now = options.now ?? (() => new Date());

  function requesterHash(address: string) {
    return createHmac('sha256', hmacSecret).update(address, 'utf8').digest('hex');
  }

  async function allowHashedRequester(hash: string) {
    return runTransaction(client, async (transaction) => {
      await transaction.query(
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [hash]
      );

      const acceptedAt = currentTime(now);
      const windowStart = new Date(acceptedAt.getTime() - rateWindowMilliseconds);
      const countResult = await transaction.query<AttemptCountRow>(
        `select count(*)::integer as accepted_count
           from (
             select 1
               from machine_connection_rate_events
              where requester_hash = $1
                and created_at > $2
              limit $3
           ) as recent_accepted_attempts`,
        [hash, windowStart, acceptedAttemptLimit]
      );

      if (attemptCount(countResult.rows[0]) >= acceptedAttemptLimit) {
        return false;
      }

      await transaction.query(
        `insert into machine_connection_rate_events (requester_hash, created_at)
         values ($1, $2)`,
        [hash, acceptedAt]
      );
      return true;
    });
  }

  return {
    async allowCreateRequest(request) {
      const address = requesterAddress(request);
      if (!address) {
        return false;
      }

      try {
        return await allowHashedRequester(requesterHash(address));
      } catch {
        return false;
      }
    },

    async cleanupOldEvents() {
      const cutoff = new Date(currentTime(now).getTime() - rateWindowMilliseconds);
      const result = await options.client.query<{ removed: number }>(
        `with expired as (
           select ctid
             from machine_connection_rate_events
            where created_at <= $1
            order by created_at
            for update skip locked
            limit $2
         )
         delete from machine_connection_rate_events as rate_event
          using expired
          where rate_event.ctid = expired.ctid
         returning 1 as removed`,
        [cutoff, cleanupBatchSize]
      );
      const removed = result.rowCount ?? result.rows.length;

      if (!Number.isSafeInteger(removed) || removed < 0 || removed > cleanupBatchSize) {
        throw new Error('The machine connection rate cleanup result was invalid.');
      }
      return removed;
    }
  };
}
