import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import type { WorkspaceRuntimeCodexMessage } from '../../src/shared/workspace-runtime-codex-api';

const schema = 'project-space.workspace-runtime-codex-journal/v1';
const maximumJournalBytes = 4 * 1024 * 1024;
const maximumCommands = 32;
const maximumEvents = 32;

export interface CodexHostCommandRecord {
  fingerprint: string;
  messages: WorkspaceRuntimeCodexMessage[];
  sequence: number;
  state: 'completed' | 'uncertain';
}

export interface CodexHostJournalState {
  acceptedCommandSequence: number;
  commands: CodexHostCommandRecord[];
  events: WorkspaceRuntimeCodexMessage[];
  lastEventSequence: number;
}

export class CodexHostJournal {
  private state: CodexHostJournalState;
  private writeTail = Promise.resolve();

  constructor(private readonly path: string, private readonly bindingDigest: string) {
    if (!isAbsolute(path)) throw new Error('The Codex host journal path must be absolute.');
    this.state = readState(path, bindingDigest);
  }

  snapshot() {
    return structuredClone(this.state);
  }

  command(sequence: number) {
    return this.state.commands.find((entry) => entry.sequence === sequence);
  }

  async beginCommand(sequence: number, fingerprint: string) {
    this.state.acceptedCommandSequence = sequence;
    this.state.commands.push({ fingerprint, messages: [], sequence, state: 'uncertain' });
    if (this.state.commands.length > maximumCommands) this.state.commands.shift();
    await this.persist();
  }

  async completeCommand(sequence: number, messages: WorkspaceRuntimeCodexMessage[]) {
    const record = this.command(sequence);
    if (!record) throw new Error('The Codex host command journal changed.');
    record.messages = structuredClone(messages);
    record.state = 'completed';
    await this.persist();
  }

  async appendEvent(message: WorkspaceRuntimeCodexMessage & { type: 'runtime.codex.event' }) {
    this.state.lastEventSequence = message.eventSequence;
    this.state.events.push(structuredClone(message));
    if (this.state.events.length > maximumEvents) this.state.events.shift();
    await this.persist();
  }

  eventsAfter(sequence: number) {
    return this.state.events.filter((entry) => (
      entry.type === 'runtime.codex.event' && entry.eventSequence > sequence
    ));
  }

  private persist() {
    const next = this.writeTail.then(() => writeState(
      this.path,
      this.bindingDigest,
      this.state
    ));
    this.writeTail = next.catch(() => undefined);
    return next;
  }
}

export function codexHostFingerprint(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function readState(path: string, bindingDigest: string): CodexHostJournalState {
  try {
    const status = lstatSync(path);
    requirePrivateFile(status.mode, status.isFile(), status.isSymbolicLink());
    if (status.size > maximumJournalBytes) throw new Error('The Codex host journal is too large.');
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (document.schema !== schema || document.bindingDigest !== bindingDigest) {
      throw new Error('The Codex host journal binding changed.');
    }
    const state = document.state as CodexHostJournalState;
    validateState(state);
    return state;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { acceptedCommandSequence: 0, commands: [], events: [], lastEventSequence: 0 };
    }
    throw error;
  }
}

async function writeState(
  path: string,
  bindingDigest: string,
  state: CodexHostJournalState
) {
  validateState(state);
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const directoryStatus = await lstat(directory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink() ||
      process.platform !== 'win32' && (directoryStatus.mode & 0o077) !== 0) {
    throw new Error('The Codex host journal directory is not private.');
  }
  const document = `${JSON.stringify({ bindingDigest, schema, state })}\n`;
  if (Buffer.byteLength(document) > maximumJournalBytes) {
    throw new Error('The Codex host journal is too large.');
  }
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(document, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function validateState(state: CodexHostJournalState) {
  if (!state || !Number.isSafeInteger(state.acceptedCommandSequence) ||
      state.acceptedCommandSequence < 0 || !Number.isSafeInteger(state.lastEventSequence) ||
      state.lastEventSequence < 0 || !Array.isArray(state.commands) ||
      state.commands.length > maximumCommands || !Array.isArray(state.events) ||
      state.events.length > maximumEvents) {
    throw new Error('The Codex host journal is invalid.');
  }
}

function requirePrivateFile(mode: number, file: boolean, symlink: boolean) {
  if (!file || symlink || process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new Error('The Codex host journal is not a private regular file.');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}
