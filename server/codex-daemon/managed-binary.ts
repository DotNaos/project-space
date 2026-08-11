import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rename,
  rm,
  symlink
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { codexRuntimeVersionCapability } from '../../src/shared/codex-runtime-release-contract';
import { resolveCodexHome } from '../codex-sessions/websocket-transport';
import {
  assertManagedCodexMaintenanceOperationId,
  managedCodexSelectionSchema,
  persistPendingManagedCodexSelection,
  readManagedCodexSelectionRecord,
  type ManagedCodexSelectionRecord,
  writeManagedCodexSelectionRecord
} from './managed-binary-selection';
import {
  assertSafeManagedCodexDirectory as assertSafeDirectory,
  createImmutableManagedCodexRelease as createImmutableRelease,
  inspectManagedCodexSourceDigest as sourceDigest,
  inspectSafeManagedCodexBinaryAt as safeBinaryAt
} from './managed-binary-release';
import { withManagedCodexRepairLock } from './managed-binary-lock';

const rollbackPointerName = 'project-space-rollback';
const legacyHoldName = '.project-space-legacy-current';

interface ManagedCodexPaths {
  current: string;
  releases: string;
  rollback: string;
  root: string;
  selection: string;
}

interface ManagedCodexSelection {
  binaryPath: string;
  digest: string;
  layout: 'legacy' | 'release';
  releaseTarget?: string;
}

export interface ManagedCodexProvisionResult {
  changed: boolean;
  currentBinaryPath: string;
  previousTarget?: string;
  releaseName: string;
  rollbackPointerPath: string;
}

export interface ManagedCodexRestoreResult {
  changed: boolean;
  currentBinaryPath?: string;
  found: boolean;
  operationId: string;
  restoredTarget?: string;
  selectedTarget?: string;
}

export interface ManagedCodexCommitResult {
  changed: boolean;
  currentBinaryPath?: string;
  found: boolean;
  operationId: string;
  previousTarget?: string;
  selectedTarget?: string;
}

function pathWithin(root: string, path: string) {
  const child = relative(root, path);
  return child === '' || (
    !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)
  );
}

async function optionalLstat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

async function syncPath(path: string) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function managedCodexPaths(
  environment: NodeJS.ProcessEnv,
  create: boolean
): Promise<ManagedCodexPaths> {
  const codexHome = resolveCodexHome(environment);
  const requestedRoot = join(codexHome, 'packages', 'standalone');
  if (create) {
    await mkdir(requestedRoot, { mode: 0o700, recursive: true });
  }
  const [resolvedHome, root] = await Promise.all([
    realpath(codexHome),
    realpath(requestedRoot)
  ]);
  if (!pathWithin(resolvedHome, root)) {
    throw new Error('The managed Codex package root escapes CODEX_HOME.');
  }
  assertSafeDirectory(await lstat(root), 'The managed Codex package root');
  const releases = join(root, 'releases');
  if (create) {
    await mkdir(releases, { mode: 0o700, recursive: true });
    assertSafeDirectory(await lstat(releases), 'The managed Codex releases root');
  } else if (await optionalLstat(releases)) {
    assertSafeDirectory(await lstat(releases), 'The managed Codex releases root');
  }
  return {
    current: join(root, 'current'),
    releases,
    rollback: join(root, rollbackPointerName),
    root,
    selection: join(root, '.project-space-maintenance-selection.json')
  };
}

async function directReleaseTarget(paths: ManagedCodexPaths, pointer: string) {
  const raw = await readlink(pointer);
  const requested = resolve(dirname(pointer), raw);
  assertSafeDirectory(
    await lstat(requested),
    'The selected managed Codex release'
  );
  const resolved = await realpath(requested);
  if (!pathWithin(paths.releases, resolved) || dirname(resolved) !== paths.releases) {
    throw new Error('The selected managed Codex release resolves outside its package root.');
  }
  const status = await lstat(resolved);
  assertSafeDirectory(status, 'The selected managed Codex release');
  return {
    absolute: resolved,
    relative: relative(paths.root, resolved)
  };
}

async function inspectCurrent(paths: ManagedCodexPaths): Promise<ManagedCodexSelection | undefined> {
  const current = await optionalLstat(paths.current);
  if (!current) return undefined;
  if (current.isSymbolicLink()) {
    const target = await directReleaseTarget(paths, paths.current);
    const binary = await safeBinaryAt(join(target.absolute, 'codex'), target.absolute);
    return {
      binaryPath: binary.path,
      digest: binary.digest,
      layout: 'release',
      releaseTarget: target.relative
    };
  }
  assertSafeDirectory(current, 'The legacy managed Codex current directory');
  const resolved = await realpath(paths.current);
  if (!pathWithin(paths.root, resolved)) {
    throw new Error('The legacy managed Codex directory escapes its package root.');
  }
  const binary = await safeBinaryAt(join(resolved, 'codex'), resolved);
  return { binaryPath: binary.path, digest: binary.digest, layout: 'legacy' };
}

async function currentReleasePointerTarget(paths: ManagedCodexPaths) {
  const current = await optionalLstat(paths.current);
  if (!current) return undefined;
  if (!current.isSymbolicLink()) return { layout: 'legacy' as const };
  try {
    const target = await directReleaseTarget(paths, paths.current);
    return { layout: 'release' as const, target: target.relative };
  } catch (error) {
    const raw = await readlink(paths.current);
    const requested = resolve(dirname(paths.current), raw);
    if (isAbsolute(raw) || !pathWithin(paths.releases, requested) ||
        dirname(requested) !== paths.releases) {
      throw error;
    }
    return { layout: 'release' as const, target: relative(paths.root, requested) };
  }
}

function legacyHoldPath(paths: ManagedCodexPaths) {
  return join(paths.root, legacyHoldName);
}

async function inspectLegacyHold(paths: ManagedCodexPaths) {
  const hold = legacyHoldPath(paths);
  const status = await optionalLstat(hold);
  if (!status) return undefined;
  assertSafeDirectory(status, 'The managed Codex legacy hold');
  const resolved = await realpath(hold);
  if (resolved !== hold || !pathWithin(paths.root, resolved)) {
    throw new Error('The managed Codex legacy hold is unsafe.');
  }
  return safeBinaryAt(join(hold, 'codex'), hold);
}

async function removeLegacyHold(paths: ManagedCodexPaths) {
  const hold = legacyHoldPath(paths);
  if (!await optionalLstat(hold)) return;
  await rm(hold, { recursive: true });
  await syncPath(paths.root);
}

async function recoverAbandonedLegacyHold(paths: ManagedCodexPaths) {
  const held = await inspectLegacyHold(paths);
  if (!held) return;
  if (!await optionalLstat(paths.current)) {
    await rename(legacyHoldPath(paths), paths.current);
    await syncPath(paths.root);
    return;
  }
  await inspectCurrent(paths);
  await removeLegacyHold(paths);
}

async function withLegacyRollbackRelease(
  paths: ManagedCodexPaths,
  current: ManagedCodexSelection | undefined
) {
  if (current?.layout !== 'legacy') return current;
  const legacyVersion = `legacy-${current.digest.slice(0, 16)}`;
  const release = await createImmutableRelease(
    paths,
    current.binaryPath,
    legacyVersion,
    current.digest
  );
  return {
    ...current,
    releaseTarget: relative(paths.root, release.releasePath)
  };
}

async function readRollbackTarget(paths: ManagedCodexPaths) {
  const status = await optionalLstat(paths.rollback);
  if (!status) return undefined;
  if (!status.isSymbolicLink()) {
    throw new Error('The managed Codex rollback pointer is unsafe.');
  }
  const target = await directReleaseTarget(paths, paths.rollback);
  await safeBinaryAt(join(target.absolute, 'codex'), target.absolute);
  return target.relative;
}

async function replacePointer(path: string, target: string) {
  const temporary = join(
    dirname(path),
    `.project-space-${randomBytes(8).toString('hex')}.pointer.tmp`
  );
  try {
    await symlink(target, temporary, 'dir');
    await rename(temporary, path);
    await syncPath(dirname(path));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readSelectionRecord(paths: ManagedCodexPaths) {
  return readManagedCodexSelectionRecord(paths.selection);
}

async function writeSelectionRecord(
  paths: ManagedCodexPaths,
  record: ManagedCodexSelectionRecord
) {
  return writeManagedCodexSelectionRecord({
    path: paths.selection,
    record,
    root: paths.root
  });
}

async function persistPendingSelection(
  paths: ManagedCodexPaths,
  record: ManagedCodexSelectionRecord
) {
  return persistPendingManagedCodexSelection({
    path: paths.selection,
    record,
    root: paths.root
  });
}

async function recordedRelease(
  paths: ManagedCodexPaths,
  target: string,
  digest: string
) {
  const requested = resolve(paths.root, target);
  if (isAbsolute(target) || !pathWithin(paths.releases, requested) ||
      dirname(requested) !== paths.releases) {
    throw new Error('The recorded managed Codex release target is unsafe.');
  }
  assertSafeDirectory(await lstat(requested), 'The recorded managed Codex release');
  const resolved = await realpath(requested);
  if (resolved !== requested) {
    throw new Error('The recorded managed Codex release target is indirect.');
  }
  const binary = await safeBinaryAt(join(resolved, 'codex'), resolved);
  if (binary.digest !== digest) {
    throw new Error('The recorded managed Codex release bytes changed.');
  }
  return binary.path;
}

function selectionRecord(input: {
  current: ManagedCodexSelection | undefined;
  operationId: string;
  selectedDigest: string;
  selectedTarget: string;
}): ManagedCodexSelectionRecord {
  return {
    operationId: input.operationId,
    previousDigest: input.current?.digest ?? null,
    previousTarget: input.current?.releaseTarget ?? null,
    schema: managedCodexSelectionSchema,
    selectedDigest: input.selectedDigest,
    selectedTarget: input.selectedTarget,
    state: 'staged'
  };
}

async function restoreRollback(paths: ManagedCodexPaths, previous?: string) {
  if (previous) {
    await replacePointer(paths.rollback, previous);
  } else {
    await rm(paths.rollback, { force: true });
  }
}

async function selectRelease(
  paths: ManagedCodexPaths,
  current: ManagedCodexSelection | undefined,
  releaseTarget: string,
  selectedDigest: string,
  operationId?: string
) {
  if (current?.layout === 'release' && current.releaseTarget === releaseTarget) {
    let previousTarget = current.releaseTarget;
    if (operationId) {
      const persisted = await persistPendingSelection(paths, selectionRecord({
        current,
        operationId,
        selectedDigest,
        selectedTarget: releaseTarget
      }));
      previousTarget = persisted.previousTarget ?? current.releaseTarget;
    }
    return { changed: false, previousTarget };
  }
  const previousRollback = await readRollbackTarget(paths);
  if (current?.layout === 'release') {
    await replacePointer(paths.rollback, current.releaseTarget!);
    try {
      if (operationId) {
        await persistPendingSelection(paths, selectionRecord({
          current,
          operationId,
          selectedDigest,
          selectedTarget: releaseTarget
        }));
      }
      await replacePointer(paths.current, releaseTarget);
    } catch (error) {
      await restoreRollback(paths, previousRollback).catch(() => undefined);
      throw error;
    }
    return { changed: true, previousTarget: current.releaseTarget };
  }
  if (current?.layout === 'legacy') {
    if (!current.releaseTarget) {
      throw new Error('The managed Codex legacy rollback release is unavailable.');
    }
    const hold = legacyHoldPath(paths);
    if (await optionalLstat(hold)) {
      throw new Error('Another managed Codex legacy migration is unfinished.');
    }
    const backupTarget = current.releaseTarget;
    await replacePointer(paths.rollback, backupTarget);
    await rename(paths.current, hold);
    await syncPath(paths.root);
    try {
      if (operationId) {
        await persistPendingSelection(paths, selectionRecord({
          current: { ...current, layout: 'release', releaseTarget: backupTarget },
          operationId,
          selectedDigest,
          selectedTarget: releaseTarget
        }));
      }
      await replacePointer(paths.current, releaseTarget);
      await removeLegacyHold(paths);
    } catch (error) {
      if (!await optionalLstat(paths.current)) {
        await rename(hold, paths.current).catch(() => undefined);
        await syncPath(paths.root).catch(() => undefined);
      }
      await restoreRollback(paths, previousRollback).catch(() => undefined);
      throw error;
    }
    return { changed: true, previousTarget: backupTarget };
  }
  if (operationId) {
    await persistPendingSelection(paths, selectionRecord({
      current,
      operationId,
      selectedDigest,
      selectedTarget: releaseTarget
    }));
  }
  await replacePointer(paths.current, releaseTarget);
  return { changed: true };
}

export async function managedCodexBinaryInstalled(environment: NodeJS.ProcessEnv) {
  try {
    const paths = await managedCodexPaths(environment, false);
    return Boolean(await inspectCurrent(paths));
  } catch {
    return false;
  }
}

export async function provisionExactManagedCodexBinary(input: {
  environment: NodeJS.ProcessEnv;
  operationId?: string;
  sourcePath: string;
  version: string;
}): Promise<ManagedCodexProvisionResult> {
  if (input.environment.PROJECT_SPACE_INSTALL_SOURCE !== 'managed') {
    throw new Error(
      'Doctor will not create a managed Codex installation from an unpinned runtime.'
    );
  }
  if (input.operationId) assertManagedCodexMaintenanceOperationId(input.operationId);
  codexRuntimeVersionCapability(input.version);
  const digest = await sourceDigest(input.sourcePath);
  const paths = await managedCodexPaths(input.environment, true);
  return withManagedCodexRepairLock(paths.root, async () => {
    await recoverAbandonedLegacyHold(paths);
    const current = await withLegacyRollbackRelease(paths, await inspectCurrent(paths));
    const release = await createImmutableRelease(
      paths,
      input.sourcePath,
      input.version,
      digest
    );
    const releaseTarget = relative(paths.root, release.releasePath);
    if (input.operationId) {
      const staged = await persistPendingSelection(paths, selectionRecord({
        current,
        operationId: input.operationId,
        selectedDigest: digest,
        selectedTarget: releaseTarget
      }));
      const unchanged = await inspectCurrent(paths);
      const atPrevious = staged.previousTarget === null
        ? unchanged === undefined
        : unchanged?.digest === staged.previousDigest && (
          unchanged.layout === 'legacy' ||
          unchanged.releaseTarget === staged.previousTarget
        );
      const atSelected = unchanged?.layout === 'release' &&
        unchanged.releaseTarget === staged.selectedTarget &&
        unchanged.digest === staged.selectedDigest;
      if (!atPrevious && !atSelected) {
        throw new Error('The managed Codex selection changed while its release was staged.');
      }
      return {
        changed: false,
        currentBinaryPath: release.binaryPath,
        ...(staged.previousTarget ? { previousTarget: staged.previousTarget } : {}),
        releaseName: release.releaseName,
        rollbackPointerPath: paths.rollback
      };
    }
    const selected = await selectRelease(paths, current, releaseTarget, digest);
    const verified = await inspectCurrent(paths);
    if (verified?.layout !== 'release' || verified.releaseTarget !== releaseTarget ||
        verified.digest !== digest) {
      throw new Error('The exact managed Codex release could not be selected.');
    }
    return {
      changed: selected.changed,
      currentBinaryPath: release.binaryPath,
      ...(selected.previousTarget ? { previousTarget: selected.previousTarget } : {}),
      releaseName: release.releaseName,
      rollbackPointerPath: paths.rollback
    };
  });
}

export async function commitManagedCodexBinarySelection(input: {
  environment: NodeJS.ProcessEnv;
  operationId: string;
}): Promise<ManagedCodexCommitResult> {
  if (input.environment.PROJECT_SPACE_INSTALL_SOURCE !== 'managed') {
    throw new Error('Doctor will not commit a managed Codex selection for an unpinned runtime.');
  }
  assertManagedCodexMaintenanceOperationId(input.operationId);
  const paths = await managedCodexPaths(input.environment, false);
  return withManagedCodexRepairLock(paths.root, async () => {
    const record = await readSelectionRecord(paths);
    if (!record || record.operationId !== input.operationId) {
      return { changed: false, found: false, operationId: input.operationId };
    }
    if (record.state === 'restored') {
      throw new Error('The restored managed Codex selection cannot be committed.');
    }
    const selectedBinary = await recordedRelease(
      paths,
      record.selectedTarget,
      record.selectedDigest
    );
    if (record.previousTarget && record.previousDigest) {
      await recordedRelease(paths, record.previousTarget, record.previousDigest);
    }
    const current = await currentReleasePointerTarget(paths);
    const legacyCurrent = current?.layout === 'legacy'
      ? await inspectCurrent(paths)
      : undefined;
    const heldLegacy = await inspectLegacyHold(paths);
    const atPrevious = record.previousTarget === null
      ? current === undefined && !heldLegacy
      : current?.layout === 'release' && current.target === record.previousTarget;
    const atLegacyPrevious = current?.layout === 'legacy' &&
      legacyCurrent?.digest === record.previousDigest;
    const heldPrevious = current === undefined &&
      heldLegacy?.digest === record.previousDigest;
    const atSelected = current?.layout === 'release' &&
      current.target === record.selectedTarget;
    if (!atPrevious && !atLegacyPrevious && !heldPrevious && !atSelected) {
      throw new Error('The managed Codex selection changed outside its maintenance transaction.');
    }
    let changed = false;
    if (!atSelected) {
      if (record.previousTarget) {
        await replacePointer(paths.rollback, record.previousTarget);
      }
      if (atLegacyPrevious) {
        if (heldLegacy) {
          throw new Error('The managed Codex legacy migration state is ambiguous.');
        }
        await rename(paths.current, legacyHoldPath(paths));
        await syncPath(paths.root);
      }
      await replacePointer(paths.current, record.selectedTarget);
      changed = true;
    }
    const verified = await inspectCurrent(paths);
    if (verified?.layout !== 'release' ||
        verified.releaseTarget !== record.selectedTarget ||
        verified.digest !== record.selectedDigest) {
      throw new Error('The staged managed Codex selection could not be committed.');
    }
    await writeSelectionRecord(paths, { ...record, state: 'committed' });
    await removeLegacyHold(paths);
    return {
      changed,
      currentBinaryPath: selectedBinary,
      found: true,
      operationId: input.operationId,
      ...(record.previousTarget ? { previousTarget: record.previousTarget } : {}),
      selectedTarget: record.selectedTarget
    };
  });
}

export async function restorePreviousManagedCodexBinary(input: {
  environment: NodeJS.ProcessEnv;
  operationId: string;
}): Promise<ManagedCodexRestoreResult> {
  if (input.environment.PROJECT_SPACE_INSTALL_SOURCE !== 'managed') {
    throw new Error('Doctor will not restore a managed Codex selection for an unpinned runtime.');
  }
  assertManagedCodexMaintenanceOperationId(input.operationId);
  const paths = await managedCodexPaths(input.environment, false);
  return withManagedCodexRepairLock(paths.root, async () => {
    const record = await readSelectionRecord(paths);
    if (!record || record.operationId !== input.operationId) {
      return { changed: false, found: false, operationId: input.operationId };
    }
    const previousBinary = record.previousTarget && record.previousDigest
      ? await recordedRelease(paths, record.previousTarget, record.previousDigest)
      : undefined;
    const current = await currentReleasePointerTarget(paths);
    const legacyCurrent = current?.layout === 'legacy'
      ? await inspectCurrent(paths)
      : undefined;
    const heldLegacy = await inspectLegacyHold(paths);
    const atPrevious = record.previousTarget === null
      ? current === undefined && !heldLegacy
      : current?.layout === 'release' && current.target === record.previousTarget;
    const atLegacyPrevious = current?.layout === 'legacy' &&
      legacyCurrent?.digest === record.previousDigest;
    const heldPrevious = current === undefined &&
      heldLegacy?.digest === record.previousDigest;
    const atSelected = current?.layout === 'release' &&
      current.target === record.selectedTarget;
    if (!atPrevious && !atLegacyPrevious && !heldPrevious && !atSelected) {
      throw new Error('The managed Codex selection changed outside its maintenance transaction.');
    }
    if (record.previousTarget) {
      const rollback = await readRollbackTarget(paths);
      if (rollback !== record.previousTarget) {
        await replacePointer(paths.rollback, record.previousTarget);
      }
    }
    let changed = false;
    if (!atPrevious && !atLegacyPrevious) {
      if (record.previousTarget) {
        await replacePointer(paths.current, record.previousTarget);
      } else {
        await rm(paths.current, { force: true });
        await syncPath(paths.root);
      }
      changed = true;
    }
    const verified = await inspectCurrent(paths);
    const previousVerified = record.previousTarget === null
      ? verified === undefined
      : verified?.digest === record.previousDigest && (
        verified.layout === 'legacy' || verified.releaseTarget === record.previousTarget
      );
    if (!previousVerified) {
      throw new Error('The previous managed Codex selection could not be restored.');
    }
    await writeSelectionRecord(paths, { ...record, state: 'restored' });
    await removeLegacyHold(paths);
    return {
      changed,
      ...(previousBinary ? { currentBinaryPath: previousBinary } : {}),
      found: true,
      operationId: input.operationId,
      ...(record.previousTarget ? { restoredTarget: record.previousTarget } : {}),
      selectedTarget: record.selectedTarget
    };
  });
}
