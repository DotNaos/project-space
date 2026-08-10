import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const secret = /(?:bearer\s+\S+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi;
const privatePath = /(?:\/(?:Users|home|root|private|opt\/platform)\/[^\s:'"`]+|[A-Za-z]:\\Users\\[^\s:'"`]+)/g;

export interface WorkspaceSandboxRequest {
  allowNetwork: boolean;
  command: string;
  maxOutputBytes: number;
  repositoryWritable: boolean;
  timeoutSeconds: number;
  workspacePath: string;
  workspaceWritable: boolean;
}

export interface WorkspaceSandboxExecution {
  cancel(): void;
  completion: Promise<{
    exitCode?: number;
    finishedAt: string;
    startedAt: string;
    state: 'cancelled' | 'completed' | 'failed';
    stderr: string;
    stdout: string;
    truncated: boolean;
  }>;
}

function sanitizedEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    SHELL: '/bin/sh',
    TERM: 'dumb',
    TMPDIR: home
  };
}

function redact(value: string, workspacePath: string) {
  return value
    .split(resolve(workspacePath)).join('[workspace]')
    .replace(secret, '[redacted]')
    .replace(privatePath, '[path]')
    .replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }, max: number) {
  if (state.bytes >= max) {
    state.truncated = true;
    return;
  }
  const remaining = max - state.bytes;
  const selected = chunk.subarray(0, remaining);
  chunks.push(selected);
  state.bytes += selected.byteLength;
  if (selected.byteLength < chunk.byteLength) state.truncated = true;
}

async function executable(candidates: string[]) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

async function gitDirectories(workspacePath: string) {
  const { stdout } = await execFileAsync('git', [
    '-C', workspacePath, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'
  ], { maxBuffer: 64 * 1024, timeout: 10_000 });
  const values = stdout.trim().split(/\r?\n/).map((value) => resolve(value));
  if (values.length !== 2) throw new Error('Workspace Git identity is unavailable.');
  return [...new Set(values)];
}

async function sandboxCommand(request: WorkspaceSandboxRequest, home: string) {
  const workspace = resolve(request.workspacePath);
  const gitDirs = await gitDirectories(workspace);
  const gitMarker = join(workspace, '.git');
  const hasGitMarker = await access(gitMarker).then(() => true, () => false);
  if (process.platform === 'linux') {
    const bwrap = await executable(['/usr/bin/bwrap', '/usr/local/bin/bwrap']);
    if (!bwrap) throw new Error('OS workspace isolation is unavailable on this connector.');
    const args = [
      '--die-with-parent', '--new-session', '--unshare-pid', '--ro-bind', '/', '/',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/home', '--tmpfs', '/root',
      '--tmpfs', '/tmp', '--dir', '/tmp/home', '--tmpfs', '/var',
      request.workspaceWritable ? '--bind' : '--ro-bind', workspace, workspace
    ];
    for (const sensitive of ['/opt/platform', '/run/user']) {
      try { await access(sensitive); args.push('--tmpfs', sensitive); } catch {}
    }
    for (const gitDir of gitDirs) args.push(
      request.repositoryWritable ? '--bind' : '--ro-bind', gitDir, gitDir
    );
    if (!request.repositoryWritable && hasGitMarker && !gitDirs.includes(gitMarker))
      args.push('--ro-bind', gitMarker, gitMarker);
    if (!request.allowNetwork) args.push('--unshare-net');
    args.push('--chdir', workspace, '--setenv', 'HOME', '/tmp/home', '--setenv', 'TMPDIR', '/tmp/home',
      '--', '/bin/sh', '-c', request.command);
    return { args, command: bwrap, cwd: workspace };
  }
  if (process.platform === 'darwin') {
    const sandbox = await executable(['/usr/bin/sandbox-exec']);
    if (!sandbox) throw new Error('OS workspace isolation is unavailable on this connector.');
    const quoted = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const reads = [workspace, ...gitDirs, '/bin', '/usr', '/System', '/Library', '/opt/homebrew', '/usr/local']
      .map((path) => `(subpath "${quoted(path)}")`).join(' ');
    const writablePaths = [
      ...(request.workspaceWritable ? [workspace] : []),
      ...(request.repositoryWritable ? gitDirs : []),
      home
    ];
    const writes = writablePaths.map((path) => `(subpath "${quoted(path)}")`).join(' ');
    const profile = [
      '(version 1)', '(deny default)', '(allow process*)',
      `(allow file-read* (literal "/") ${reads})`,
      `(allow file-write* ${writes})`,
      ...(!request.repositoryWritable && hasGitMarker
        ? [`(deny file-write* (subpath "${quoted(gitMarker)}"))`] : []),
      request.allowNetwork ? '(allow network*)' : '(deny network*)'
    ].join(' ');
    return { args: ['-p', profile, '/bin/sh', '-c', request.command], command: sandbox, cwd: workspace };
  }
  throw new Error('OS workspace isolation is unsupported on this connector.');
}

function terminate(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    if (child.exitCode !== null || !child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, 500).unref();
}

export async function startWorkspaceSandbox(
  request: WorkspaceSandboxRequest
): Promise<WorkspaceSandboxExecution> {
  const privateHome = await mkdtemp(join(tmpdir(), 'project-space-command-'));
  let cancelled = false;
  let child: ChildProcess;
  try {
    const launch = await sandboxCommand(request, privateHome);
    child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      detached: process.platform !== 'win32',
      env: sanitizedEnvironment(privateHome),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (error) {
    await rm(privateHome, { force: true, recursive: true });
    throw error;
  }
  const startedAt = new Date().toISOString();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const output = { bytes: 0, truncated: false };
  child.stdout?.on('data', (chunk: Buffer) => appendBounded(stdout, chunk, output, request.maxOutputBytes));
  child.stderr?.on('data', (chunk: Buffer) => appendBounded(stderr, chunk, output, request.maxOutputBytes));
  const timer = setTimeout(() => terminate(child), request.timeoutSeconds * 1_000);
  timer.unref();
  const completion = new Promise<Awaited<WorkspaceSandboxExecution['completion']>>((resolveResult) => {
    let settled = false;
    const finish = async (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = redact(Buffer.concat(stdout).toString('utf8'), request.workspacePath);
      const err = redact(Buffer.concat(stderr).toString('utf8'), request.workspacePath);
      await rm(privateHome, { force: true, recursive: true });
      resolveResult({
        ...(code !== null ? { exitCode: code } : {}),
        finishedAt: new Date().toISOString(),
        startedAt,
        state: cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed',
        stderr: error ? `${err}${err ? '\n' : ''}${redact(error.message, request.workspacePath)}` : err,
        stdout: out,
        truncated: output.truncated
      });
    };
    child.once('error', (error) => void finish(null, error));
    child.once('close', (code) => void finish(code));
  });
  return {
    cancel() { cancelled = true; terminate(child); },
    completion
  };
}
