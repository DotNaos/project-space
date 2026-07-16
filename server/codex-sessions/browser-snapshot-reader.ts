import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  CODEX_BROWSER_MAXIMUM_IMAGE_BYTES,
  CODEX_THREAD_ID_PATTERN,
  type CodexSessionBrowserResult
} from '../../src/shared/codex-sessions-api';

const MAXIMUM_LINE_BYTES = 12 * 1024 * 1024;
const BROWSER_MARKER = Buffer.from('codex/browserUse');
export const CODEX_BROWSER_SNAPSHOT_CACHE_LIMIT = 24;
const ROLLOUT_INDEX_LIMIT = 50_000;
const ROLLOUT_ROOT_INDEX_LIMIT = 4;
const MISSING_ROLLOUT_LOOKUP_TTL_MS = 30_000;
const DATE_SEGMENT_PATTERN = /^\d{2}$/;
const YEAR_SEGMENT_PATTERN = /^\d{4}$/;

interface ReadObservation {
  end: number;
  path: string;
  start: number;
}

export interface CodexBrowserSnapshotReaderOptions {
  afterImageRevision?: string;
  codexHome?: string;
  now?: () => Date;
  /** Test/diagnostic hook. Called only when the date hierarchy must be scanned. */
  onLookup?: (sessionsRoot: string, threadId: string) => void;
  /** Test/diagnostic hook. Byte offsets are inclusive. */
  onRead?: (observation: ReadObservation) => void;
  /** Test/diagnostic hook. Reports bounded cache sizes after a successful read. */
  onCache?: (sizes: { paths: number; states: number }) => void;
  sessionsRoot?: string;
}

interface BrowserFrame {
  imageDataUrl: string;
  imageRevision: string;
  pageUrl?: string;
  turnId?: string;
}

interface RolloutState {
  browserObserved: boolean;
  currentTurnActive: boolean;
  currentTurnId?: string;
  device: number;
  identityRejected: boolean;
  identityVerified: boolean;
  inode: number;
  invalidBrowserRecord: boolean;
  latestFrame?: BrowserFrame;
  latestObservedAt?: string;
  latestTurnId?: string;
  offset: number;
  recordedId?: string;
}

interface RolloutIndex {
  expiresAt: number;
  paths: Map<string, string>;
}

const rolloutPaths = new Map<string, string>();
const missingRollouts = new Map<string, number>();
const rolloutStates = new Map<string, RolloutState>();
const rolloutLoads = new Map<string, Promise<unknown>>();
const rolloutIndexes = new Map<string, RolloutIndex>();
const rolloutIndexLoads = new Map<string, Promise<RolloutIndex>>();

export async function readCodexBrowserSnapshot(
  machineId: string,
  threadId: string,
  options: CodexBrowserSnapshotReaderOptions = {}
): Promise<CodexSessionBrowserResult> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const base = { checkedAt, machineId, threadId };
  if (!CODEX_THREAD_ID_PATTERN.test(threadId)) {
    return { ...base, reason: 'The Codex task identity is invalid.', state: 'unavailable' };
  }

  try {
    const root = await sessionsRoot(options);
    const path = await findRollout(root, threadId, options);
    if (!path) {
      return { ...base, reason: 'The Codex task history is no longer available.', state: 'unavailable' };
    }
    const observation = await loadSerially(path, () => inspectRollout(
      root,
      path,
      threadId,
      options
    ));
    options.onCache?.({ paths: rolloutPaths.size, states: rolloutStates.size });
    return { ...base, ...observation } as CodexSessionBrowserResult;
  } catch {
    return { ...base, reason: 'The browser mirror is temporarily unavailable.', state: 'unavailable' };
  }
}

async function sessionsRoot(options: CodexBrowserSnapshotReaderOptions) {
  const configuredHome = options.codexHome?.trim() || process.env.CODEX_HOME?.trim();
  const requested = options.sessionsRoot?.trim() ||
    resolve(configuredHome || resolve(homedir(), '.codex'), 'sessions');
  if (!isAbsolute(requested)) throw new Error('The Codex sessions root must be absolute.');
  return realpath(requested);
}

async function findRollout(
  root: string,
  threadId: string,
  options: CodexBrowserSnapshotReaderOptions
) {
  const key = `${root}\u0000${threadId}`;
  const cached = rolloutPaths.get(key);
  if (cached && await validRollout(root, cached, threadId)) {
    rememberBounded(rolloutPaths, key, cached);
    return cached;
  }
  rolloutPaths.delete(key);
  const missingUntil = missingRollouts.get(key);
  if (missingUntil && missingUntil > Date.now()) {
    rememberBounded(missingRollouts, key, missingUntil);
    return undefined;
  }
  missingRollouts.delete(key);
  const index = await rolloutIndex(root, threadId, options);
  const path = index.paths.get(threadId);
  if (path) {
    missingRollouts.delete(key);
    rememberBounded(rolloutPaths, key, path);
  } else {
    rememberBounded(missingRollouts, key, Date.now() + MISSING_ROLLOUT_LOOKUP_TTL_MS);
  }
  return path;
}

async function rolloutIndex(
  root: string,
  requestedThreadId: string,
  options: CodexBrowserSnapshotReaderOptions
) {
  const cached = rolloutIndexes.get(root);
  if (cached && cached.expiresAt > Date.now()) {
    rememberBounded(rolloutIndexes, root, cached, ROLLOUT_ROOT_INDEX_LIMIT);
    return cached;
  }
  const existingLoad = rolloutIndexLoads.get(root);
  if (existingLoad) return existingLoad;
  const load = buildRolloutIndex(root, requestedThreadId, options);
  rolloutIndexLoads.set(root, load);
  try {
    const index = await load;
    rememberBounded(rolloutIndexes, root, index, ROLLOUT_ROOT_INDEX_LIMIT);
    return index;
  } finally {
    if (rolloutIndexLoads.get(root) === load) rolloutIndexLoads.delete(root);
  }
}

async function buildRolloutIndex(
  root: string,
  requestedThreadId: string,
  options: CodexBrowserSnapshotReaderOptions
): Promise<RolloutIndex> {
  options.onLookup?.(root, requestedThreadId);
  const candidates: Array<{ modifiedAt: number; path: string }> = [];
  for (const year of await safeDirectories(root, YEAR_SEGMENT_PATTERN)) {
    for (const month of await safeDirectories(resolve(root, year), DATE_SEGMENT_PATTERN)) {
      for (const day of await safeDirectories(resolve(root, year, month), DATE_SEGMENT_PATTERN)) {
        const directory = resolve(root, year, month, day);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl')) continue;
          const candidateThreadId = entry.name.slice(-42, -6);
          if (!CODEX_THREAD_ID_PATTERN.test(candidateThreadId)) continue;
          const path = await realpath(resolve(directory, entry.name));
          requireWithinRoot(root, path);
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink()) continue;
          candidates.push({ modifiedAt: info.mtimeMs, path });
        }
      }
    }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const paths = new Map<string, string>();
  for (const candidate of candidates.slice(0, ROLLOUT_INDEX_LIMIT)) {
    const threadId = candidate.path.slice(-42, -6);
    if (!paths.has(threadId)) paths.set(threadId, candidate.path);
  }
  return { expiresAt: Date.now() + MISSING_ROLLOUT_LOOKUP_TTL_MS, paths };
}

async function validRollout(root: string, path: string, threadId: string) {
  try {
    if (!path.endsWith(`-${threadId}.jsonl`)) return false;
    const canonicalPath = await realpath(path);
    requireWithinRoot(root, canonicalPath);
    const info = await lstat(canonicalPath);
    return canonicalPath === path && info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function safeDirectories(parent: string, pattern: RegExp) {
  return (await readdir(parent, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && pattern.test(entry.name))
    .map((entry) => entry.name);
}

function requireWithinRoot(root: string, path: string) {
  const child = relative(root, path);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error('The rollout path escaped the Codex sessions root.');
  }
}

async function loadSerially<T>(
  path: string,
  load: () => Promise<T>
): Promise<T> {
  const previous = rolloutLoads.get(path) ?? Promise.resolve(undefined);
  const current = (async () => {
    try {
      await previous;
    } catch {
      // A later poll can retry after an earlier transient read failure.
    }
    return load();
  })();
  rolloutLoads.set(path, current);
  try {
    return await current;
  } finally {
    if (rolloutLoads.get(path) === current) rolloutLoads.delete(path);
  }
}

async function inspectRollout(
  root: string,
  path: string,
  expectedThreadId: string,
  options: CodexBrowserSnapshotReaderOptions
) {
  const canonicalPath = await realpath(path);
  requireWithinRoot(root, canonicalPath);
  if (canonicalPath !== path) throw new Error('The rollout path changed identity.');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('The rollout is not a safe regular file.');
  }

  let state = rolloutStates.get(path);
  if (!state || state.device !== info.dev || state.inode !== info.ino || info.size < state.offset) {
    state = emptyState(info.dev, info.ino);
  }
  rememberBounded(rolloutStates, path, state);
  if (info.size > state.offset) {
    const start = state.offset;
    const end = info.size - 1;
    options.onRead?.({ end, path, start });
    state.offset += await processAppendedRecords(path, start, end, state);
  }
  return observationFromState(state, expectedThreadId, options.afterImageRevision);
}

function rememberBounded<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  limit = CODEX_BROWSER_SNAPSHOT_CACHE_LIMIT
) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function emptyState(device: number, inode: number): RolloutState {
  return {
    browserObserved: false,
    currentTurnActive: false,
    device,
    identityRejected: false,
    identityVerified: false,
    inode,
    invalidBrowserRecord: false,
    offset: 0
  };
}

async function processAppendedRecords(
  path: string,
  start: number,
  end: number,
  state: RolloutState
) {
  let committed = 0;
  let consumed = 0;
  let lineBytes = 0;
  let lineChunks: Buffer[] = [];
  let markerSeen = false;
  let markerTail = Buffer.alloc(0);
  let oversized = false;

  function observeSegment(segment: Buffer) {
    const searchable = markerTail.length > 0
      ? Buffer.concat([markerTail, segment])
      : segment;
    markerSeen ||= searchable.includes(BROWSER_MARKER);
    markerTail = Buffer.from(
      searchable.subarray(Math.max(0, searchable.length - BROWSER_MARKER.length + 1))
    );
    lineBytes += segment.length;
    if (!oversized && lineBytes <= MAXIMUM_LINE_BYTES) {
      lineChunks.push(segment);
    } else {
      oversized = true;
      lineChunks = [];
    }
  }

  function finishLine(complete: boolean) {
    if (oversized) {
      if (markerSeen) state.invalidBrowserRecord = true;
      return true;
    }
    const line = Buffer.concat(lineChunks, lineBytes);
    if (!complete && !validJson(line)) return false;
    processLine(state, line);
    return true;
  }

  function resetLine() {
    lineBytes = 0;
    lineChunks = [];
    markerSeen = false;
    markerTail = Buffer.alloc(0);
    oversized = false;
  }

  for await (const value of createReadStream(path, { end, start })) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      const segmentEnd = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(cursor, segmentEnd);
      observeSegment(segment);
      consumed += segment.length;
      if (newline === -1) break;
      consumed += 1;
      finishLine(true);
      committed = consumed;
      resetLine();
      cursor = newline + 1;
    }
  }
  if (lineBytes > 0 && finishLine(false)) committed = consumed;
  return committed;
}

function validJson(line: Buffer) {
  if (line.length === 0 || line.length > MAXIMUM_LINE_BYTES) return line.length === 0;
  try {
    JSON.parse(line.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

function processLine(state: RolloutState, line: Buffer) {
  if (line.length === 0) return;
  if (line.length > MAXIMUM_LINE_BYTES) {
    if (line.includes('codex/browserUse')) state.invalidBrowserRecord = true;
    return;
  }
  let record: unknown;
  try {
    record = JSON.parse(line.toString('utf8'));
  } catch {
    if (line.includes('codex/browserUse')) state.invalidBrowserRecord = true;
    return;
  }
  if (!isRecord(record) || !isRecord(record.payload)) return;
  const payload = record.payload;
  if (record.type === 'session_meta') {
    const id = payload.id ?? payload.session_id;
    if (state.recordedId && state.recordedId !== id) state.identityRejected = true;
    if (typeof id === 'string') state.identityVerified = true;
    if (typeof id !== 'string' || !CODEX_THREAD_ID_PATTERN.test(id)) state.identityRejected = true;
    if (typeof id === 'string') state.recordedId = id;
    return;
  }
  if (record.type !== 'event_msg') return;
  if (payload.type === 'task_started') {
    state.currentTurnId = identifier(payload.turn_id);
    state.currentTurnActive = Boolean(state.currentTurnId);
    state.browserObserved = false;
    state.invalidBrowserRecord = false;
    state.latestFrame = undefined;
    state.latestObservedAt = undefined;
    state.latestTurnId = undefined;
    return;
  }
  if (payload.type === 'task_complete' && payload.turn_id === state.currentTurnId) {
    state.currentTurnActive = false;
    return;
  }
  const browser = browserMetadata(payload);
  if (!browser) return;
  state.browserObserved = true;
  state.latestObservedAt = timestamp(record.timestamp) ?? state.latestObservedAt;
  state.latestTurnId = state.currentTurnId;
  state.invalidBrowserRecord = browser.invalid;
  if (!browser.invalid && browser.frame) {
    state.latestFrame = {
      ...browser.frame,
      ...(state.currentTurnId ? { turnId: state.currentTurnId } : {})
    };
  }
}

function observationFromState(
  state: RolloutState,
  expectedThreadId?: string,
  afterImageRevision?: string
) {
  if (!state.identityVerified || state.identityRejected || state.recordedId !== expectedThreadId) {
    return { reason: 'The Codex task identity could not be verified.', state: 'unavailable' as const };
  }
  if (state.invalidBrowserRecord) {
    return {
      ...(state.latestObservedAt ? { observedAt: state.latestObservedAt } : {}),
      ...(state.latestTurnId ? { turnId: state.latestTurnId } : {}),
      reason: 'The browser mirror returned an invalid frame.',
      state: 'unavailable' as const
    };
  }
  if (!state.browserObserved) return { state: 'never-used' as const };
  if (state.currentTurnActive && state.latestTurnId === state.currentTurnId) {
    if (!state.latestFrame || state.latestFrame.turnId !== state.currentTurnId) {
      return {
        ...(state.latestObservedAt ? { observedAt: state.latestObservedAt } : {}),
        ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
        state: 'loading' as const
      };
    }
    return {
      ...(afterImageRevision === state.latestFrame.imageRevision
        ? { imageUnchanged: true as const }
        : { imageDataUrl: state.latestFrame.imageDataUrl }),
      imageRevision: state.latestFrame.imageRevision,
      ...(state.latestObservedAt ? { observedAt: state.latestObservedAt } : {}),
      ...(state.latestFrame.pageUrl ? { pageUrl: state.latestFrame.pageUrl } : {}),
      ...(state.currentTurnId ? { turnId: state.currentTurnId } : {}),
      state: 'live' as const
    };
  }
  return {
    ...(state.latestFrame
      ? {
          ...(afterImageRevision === state.latestFrame.imageRevision
            ? { imageUnchanged: true as const }
            : { imageDataUrl: state.latestFrame.imageDataUrl }),
          imageRevision: state.latestFrame.imageRevision
        }
      : {}),
    ...(state.latestObservedAt ? { observedAt: state.latestObservedAt } : {}),
    ...(state.latestFrame?.pageUrl ? { pageUrl: state.latestFrame.pageUrl } : {}),
    ...(state.latestTurnId ? { turnId: state.latestTurnId } : {}),
    reason: 'The browser activity for this turn has ended.',
    state: 'ended' as const
  };
}

function browserMetadata(payload: Record<string, unknown>) {
  if (payload.type !== 'mcp_tool_call_end' || !isRecord(payload.result)) return undefined;
  const result = payload.result;
  if (!isRecord(result.Ok) || !isRecord(result.Ok._meta)) return undefined;
  const metadata = result.Ok._meta;
  if (metadata['codex/browserUse'] !== true) return undefined;
  const surface = metadata['codex/toolSurface'];
  if (!isRecord(surface) || surface.kind !== 'browserUse') return { invalid: true as const };
  if (surface.screenshot === undefined) return emittedContentFrame(result.Ok.content);
  if (!isRecord(surface.screenshot)) return { invalid: true as const };
  const imageDataUrl = sanitizedImageDataUrl(surface.screenshot.url);
  if (!imageDataUrl) return { invalid: true as const };
  const pageUrl = sanitizedPageOrigin(surface.screenshot.pageUrl);
  if (surface.screenshot.pageUrl !== undefined && !pageUrl) return { invalid: true as const };
  return {
    frame: {
      imageDataUrl,
      imageRevision: imageRevision(imageDataUrl),
      ...(pageUrl ? { pageUrl } : {})
    },
    invalid: false as const
  };
}

function emittedContentFrame(value: unknown) {
  if (value === undefined) return { invalid: false as const };
  if (!Array.isArray(value)) return { invalid: true as const };
  const images = value.filter((item) => isRecord(item) && item.type === 'image');
  if (images.length === 0) return { invalid: false as const };
  const image = images.at(-1)!;
  if (typeof image.mimeType !== 'string' || typeof image.data !== 'string' ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)) {
    return { invalid: true as const };
  }
  const imageDataUrl = sanitizedImageDataUrl(`data:${image.mimeType};base64,${image.data}`);
  return imageDataUrl
    ? {
        frame: { imageDataUrl, imageRevision: imageRevision(imageDataUrl) },
        invalid: false as const
      }
    : { invalid: true as const };
}

function imageRevision(imageDataUrl: string) {
  return createHash('sha256').update(imageDataUrl).digest('hex');
}

function sanitizedImageDataUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2_100_000) return undefined;
  const match = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2]!.length % 4 !== 0) return undefined;
  const padding = match[2]!.endsWith('==') ? 2 : match[2]!.endsWith('=') ? 1 : 0;
  const bytes = match[2]!.length * 3 / 4 - padding;
  if (!Number.isSafeInteger(bytes) || bytes < 1 ||
    bytes > CODEX_BROWSER_MAXIMUM_IMAGE_BYTES) return undefined;
  return value;
}

function sanitizedPageOrigin(value: unknown) {
  if (typeof value !== 'string' || value.length > 4_096) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function identifier(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    ? value
    : undefined;
}

function timestamp(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
