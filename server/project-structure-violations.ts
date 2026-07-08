import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  ProjectStructureActionRequest,
  ProjectStructureActionResult,
  ProjectTrashEntryRecord,
  ProjectTrashListResult,
  ProjectTrashRestoreRequest,
  ProjectTrashRestoreResult,
  ProjectStructureViolationRecord,
  ProjectStructureViolationType
} from '../src/shared/project-space-api';

const execFileAsync = promisify(execFile);
const projectSpaceDirectory = join(homedir(), '.project-space');
const localOnlyProjectsFile = join(projectSpaceDirectory, 'local-only-projects.json');
const archiveDirectoryName = '.archive';
const legacyTrashDirectoryName = '.trash';
const reservedRootDirectories = new Set([
  '.devboxes',
  archiveDirectoryName,
  legacyTrashDirectoryName,
  '.worktrees'
]);
const ignoredSystemFiles = new Set(['.DS_Store', '.localized']);

interface TrashMetadata {
  originalPath?: string;
  reason?: ProjectStructureViolationType;
  relativePath?: string;
  trashedAt?: string;
}

async function listEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function hasGitEntry(path: string) {
  return existsSync(join(path, '.git'));
}

function nestedSameNameGitCheckout(path: string) {
  const nestedPath = join(path, basename(path));

  return hasGitEntry(nestedPath) ? nestedPath : '';
}

async function hasGitHubRemote(path: string) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'remote', '-v'], {
      windowsHide: true
    });

    return stdout
      .split('\n')
      .some((line) => /\bgithub\.com[:/]/i.test(line) || /https:\/\/github\.com\//i.test(line));
  } catch {
    return false;
  }
}

function readLocalOnlyProjectPaths() {
  try {
    const parsed = JSON.parse(readFileSync(localOnlyProjectsFile, 'utf-8')) as unknown;

    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }

    return new Set(
      parsed
        .filter((path): path is string => typeof path === 'string')
        .map((path) => resolve(path))
    );
  } catch {
    return new Set<string>();
  }
}

function writeLocalOnlyProjectPath(path: string) {
  const paths = readLocalOnlyProjectPaths();
  paths.add(resolve(path));
  mkdirSync(projectSpaceDirectory, { recursive: true });
  writeFileSync(localOnlyProjectsFile, JSON.stringify([...paths].sort(), null, 2));
}

function relativeFrom(rootPath: string, path: string) {
  return relative(rootPath, path).replaceAll('\\', '/') || basename(path);
}

function createViolation({
  detail,
  path,
  projectName,
  rootPath,
  severity = 'error',
  title,
  type
}: {
  detail: string;
  path: string;
  projectName?: string;
  rootPath: string;
  severity?: ProjectStructureViolationRecord['severity'];
  title: string;
  type: ProjectStructureViolationType;
}): ProjectStructureViolationRecord {
  const resolvedPath = resolve(path);
  const relativePath = relativeFrom(rootPath, resolvedPath);

  return {
    detail,
    id: `${type}:${relativePath}`,
    name: basename(resolvedPath),
    path: resolvedPath,
    projectName,
    relativePath,
    severity,
    title,
    type
  };
}

function isIgnoredSystemEntry(entry: Dirent) {
  return ignoredSystemFiles.has(entry.name);
}

async function collectWorktreeViolations(rootPath: string) {
  const worktreesPath = join(rootPath, '.worktrees');
  const violations: ProjectStructureViolationRecord[] = [];

  if (!existsSync(worktreesPath)) {
    return violations;
  }

  const projectEntries = await listEntries(worktreesPath);

  for (const projectEntry of projectEntries) {
    const projectPath = join(worktreesPath, projectEntry.name);

    if (isIgnoredSystemEntry(projectEntry)) {
      continue;
    }

    if (!projectEntry.isDirectory()) {
      violations.push(
        createViolation({
          detail: 'Files do not belong directly inside .worktrees.',
          path: projectPath,
          rootPath,
          title: 'Stray file in .worktrees',
          type: 'worktrees_stray_file'
        })
      );
      continue;
    }

    if (hasGitEntry(projectPath)) {
      violations.push(
        createViolation({
          detail: 'Worktrees must live under .worktrees/{project}/{branch}.',
          path: projectPath,
          rootPath,
          title: 'Missing project layer',
          type: 'worktrees_missing_project_layer'
        })
      );
      continue;
    }

    const mainProjectPath = join(rootPath, projectEntry.name);
    if (!hasGitEntry(mainProjectPath)) {
      violations.push(
        createViolation({
          detail: `Expected main project folder ${projectEntry.name} in the projects root.`,
          path: projectPath,
          projectName: projectEntry.name,
          rootPath,
          title: 'Orphan worktree container',
          type: 'orphan_worktree_container'
        })
      );
    }

    const branchEntries = await listEntries(projectPath);
    for (const branchEntry of branchEntries) {
      const branchPath = join(projectPath, branchEntry.name);

      if (isIgnoredSystemEntry(branchEntry)) {
        continue;
      }

      if (!branchEntry.isDirectory()) {
        violations.push(
          createViolation({
            detail: `Files do not belong inside .worktrees/${projectEntry.name}.`,
            path: branchPath,
            projectName: projectEntry.name,
            rootPath,
            title: 'Stray file in worktree project',
            type: 'worktree_project_stray_file'
          })
        );
        continue;
      }

      if (!hasGitEntry(branchPath)) {
        violations.push(
          createViolation({
            detail: 'Worktree branch folders must be Git worktrees with a .git entry.',
            path: branchPath,
            projectName: projectEntry.name,
            rootPath,
            title: 'Stray worktree folder',
            type: 'worktree_stray_folder'
          })
        );
      }
    }
  }

  return violations;
}

export async function collectProjectStructureViolations(rootPath: string) {
  const violations: ProjectStructureViolationRecord[] = [];
  const rootEntries = await listEntries(rootPath);
  const localOnlyProjectPaths = readLocalOnlyProjectPaths();

  for (const rootEntry of rootEntries) {
    const entryPath = join(rootPath, rootEntry.name);

    if (isIgnoredSystemEntry(rootEntry)) {
      continue;
    }

    if (rootEntry.isDirectory()) {
      if (reservedRootDirectories.has(rootEntry.name)) {
        continue;
      }

      const nestedCheckoutPath = nestedSameNameGitCheckout(entryPath);

      if (nestedCheckoutPath) {
        violations.push(
          createViolation({
            detail:
              'The main checkout is nested one level too deep. Main checkouts must live directly under ~/projects/{project}.',
            path: nestedCheckoutPath,
            projectName: rootEntry.name,
            rootPath,
            title: 'Nested project checkout',
            type: 'nested_project_checkout'
          })
        );
        continue;
      }

      if (hasGitEntry(entryPath)) {
        const resolvedEntryPath = resolve(entryPath);

        if (!localOnlyProjectPaths.has(resolvedEntryPath) && !(await hasGitHubRemote(entryPath))) {
          violations.push(
            createViolation({
              detail: 'Git projects in ~/projects should be connected to a GitHub remote.',
              path: entryPath,
              projectName: rootEntry.name,
              rootPath,
              severity: 'warning',
              title: 'No GitHub remote',
              type: 'git_repo_missing_github_remote'
            })
          );
        }

        continue;
      }

      violations.push(
        createViolation({
          detail: 'Direct folders under the projects root must be Git repositories.',
          path: entryPath,
          projectName: rootEntry.name,
          rootPath,
          title: 'Stray folder',
          type: 'root_stray_folder'
        })
      );
      continue;
    }

    violations.push(
      createViolation({
        detail: 'Files do not belong directly inside the projects root.',
        path: entryPath,
        rootPath,
        title: 'Stray file',
        type: 'root_stray_file'
      })
    );
  }

  violations.push(...(await collectWorktreeViolations(rootPath)));

  return violations.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function assertPathInsideRoot(rootPath: string, path: string) {
  const resolvedRoot = resolve(rootPath);
  const resolvedPath = resolve(path);
  const relativePath = relative(resolvedRoot, resolvedPath);

  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Path is outside the projects root.');
  }

  return { relativePath: relativePath.replaceAll('\\', '/'), resolvedPath };
}

function isPathInsideRoot(rootPath: string, path: string) {
  const relativePath = relative(resolve(rootPath), resolve(path));

  return Boolean(relativePath) && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function slugifyName(value: string) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function timestampSlug() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
}

function moveToTrash(rootPath: string, path: string, reason: ProjectStructureViolationType) {
  const { relativePath, resolvedPath } = assertPathInsideRoot(rootPath, path);

  if (!existsSync(resolvedPath)) {
    throw new Error('Path no longer exists.');
  }

  if (
    relativePath === archiveDirectoryName ||
    relativePath.startsWith(`${archiveDirectoryName}/`) ||
    relativePath === legacyTrashDirectoryName ||
    relativePath.startsWith(`${legacyTrashDirectoryName}/`)
  ) {
    throw new Error('Cannot archive archive contents again.');
  }

  const trashEntryPath = join(
    rootPath,
    archiveDirectoryName,
    `${timestampSlug()}-${slugifyName(basename(resolvedPath))}`
  );
  const trashedItemPath = join(trashEntryPath, 'item');

  mkdirSync(trashEntryPath, { recursive: true });
  renameSync(resolvedPath, trashedItemPath);
  writeFileSync(
    join(trashEntryPath, 'archive.json'),
    JSON.stringify(
      {
        originalPath: resolvedPath,
        reason,
        relativePath,
        trashedAt: new Date().toISOString()
      },
      null,
      2
    )
  );

  return trashEntryPath;
}

function readTrashMetadata(entryPath: string): TrashMetadata | undefined {
  try {
    const metadataPath = existsSync(join(entryPath, 'archive.json'))
      ? join(entryPath, 'archive.json')
      : join(entryPath, 'trash.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as unknown;

    if (!metadata || typeof metadata !== 'object') {
      return undefined;
    }

    return metadata as TrashMetadata;
  } catch {
    return undefined;
  }
}

function trashEntryToRecord(
  rootPath: string,
  entryPath: string
): ProjectTrashEntryRecord | undefined {
  const itemPath = join(entryPath, 'item');
  const metadata = readTrashMetadata(entryPath);

  if (!metadata?.originalPath || !metadata.relativePath || !metadata.reason || !metadata.trashedAt) {
    return undefined;
  }

  if (!existsSync(itemPath)) {
    return undefined;
  }

  return {
    id: relativeFrom(rootPath, entryPath),
    itemPath,
    name: basename(metadata.originalPath),
    originalPath: metadata.originalPath,
    originalRelativePath: metadata.relativePath,
    reason: metadata.reason,
    trashPath: entryPath,
    trashedAt: metadata.trashedAt
  };
}

export async function listProjectTrash(rootPath: string): Promise<ProjectTrashListResult> {
  const archivePath = join(rootPath, archiveDirectoryName);
  const legacyTrashPath = join(rootPath, legacyTrashDirectoryName);
  const archiveEntries = await listEntries(archivePath);
  const legacyTrashEntries = await listEntries(legacyTrashPath);

  return {
    entries: [
      ...archiveEntries.map((entry) => ({ entry, root: archivePath })),
      ...legacyTrashEntries.map((entry) => ({ entry, root: legacyTrashPath }))
    ]
      .filter(({ entry }) => entry.isDirectory())
      .map(({ entry, root }) => trashEntryToRecord(rootPath, join(root, entry.name)))
      .filter((entry): entry is ProjectTrashEntryRecord => Boolean(entry))
      .sort((left, right) => right.trashedAt.localeCompare(left.trashedAt)),
    trashPath: archivePath
  };
}

export async function restoreProjectTrashEntry(
  rootPath: string,
  request: ProjectTrashRestoreRequest
): Promise<ProjectTrashRestoreResult> {
  try {
    const archiveRootPath = resolve(rootPath, archiveDirectoryName);
    const legacyTrashRootPath = resolve(rootPath, legacyTrashDirectoryName);
    const trashPath = resolve(request.trashPath);

    const isArchiveEntry =
      trashPath !== archiveRootPath && isPathInsideRoot(archiveRootPath, trashPath);
    const isLegacyTrashEntry =
      trashPath !== legacyTrashRootPath && isPathInsideRoot(legacyTrashRootPath, trashPath);

    if (!isArchiveEntry && !isLegacyTrashEntry) {
      throw new Error('Archive entry is outside the project archive folder.');
    }

    const record = trashEntryToRecord(rootPath, trashPath);

    if (!record) {
      throw new Error('Archive entry is missing or incomplete.');
    }

    const restoredPath = resolve(record.originalPath);

    if (!isPathInsideRoot(rootPath, restoredPath)) {
      throw new Error('Original location is outside the projects root.');
    }

    if (existsSync(restoredPath)) {
      throw new Error('Cannot restore because the original location already exists.');
    }

    mkdirSync(dirname(restoredPath), { recursive: true });
    renameSync(record.itemPath, restoredPath);
    rmSync(trashPath, { force: true, recursive: true });

    return {
      message: `Restored ${record.originalRelativePath}.`,
      restoredPath,
      status: 'success'
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Restore failed.',
      status: 'error'
    };
  }
}

function moveToPoc(rootPath: string, path: string) {
  const { resolvedPath } = assertPathInsideRoot(rootPath, path);

  if (!existsSync(resolvedPath)) {
    throw new Error('Path no longer exists.');
  }

  const statName = basename(resolvedPath);
  const projectsPocPath = join(dirname(resolve(rootPath)), 'projects.poc');
  const targetPath = join(projectsPocPath, statName);
  const finalTargetPath = existsSync(targetPath)
    ? join(projectsPocPath, `${timestampSlug()}-${slugifyName(statName)}`)
    : targetPath;

  mkdirSync(projectsPocPath, { recursive: true });
  renameSync(resolvedPath, finalTargetPath);

  return finalTargetPath;
}

async function initializeGit(rootPath: string, path: string) {
  const { resolvedPath } = assertPathInsideRoot(rootPath, path);

  if (!existsSync(resolvedPath)) {
    throw new Error('Path no longer exists.');
  }

  if (hasGitEntry(resolvedPath)) {
    return;
  }

  await execFileAsync('git', ['-C', resolvedPath, 'init'], {
    windowsHide: true
  });
}

export async function applyProjectStructureAction(
  rootPath: string,
  request: ProjectStructureActionRequest
): Promise<ProjectStructureActionResult> {
  try {
    if (request.action === 'move_to_trash') {
      const trashPath = moveToTrash(rootPath, request.path, request.type);

      return {
        message: 'Moved to archive.',
        status: 'success',
        trashPath
      };
    }

    if (request.action === 'move_to_poc') {
      const pocPath = moveToPoc(rootPath, request.path);

      return {
        message: `Moved to ${pocPath.replace(`${homedir()}/`, '~/')}.`,
        status: 'success'
      };
    }

    if (request.action === 'initialize_git') {
      await initializeGit(rootPath, request.path);

      return {
        message: 'Initialized Git repository.',
        status: 'success'
      };
    }

    if (request.action === 'keep_local_only') {
      const { resolvedPath } = assertPathInsideRoot(rootPath, request.path);
      writeLocalOnlyProjectPath(resolvedPath);

      return {
        message: 'Marked as local only.',
        status: 'success'
      };
    }

    return {
      message: 'Unsupported action.',
      status: 'error'
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Action failed.',
      status: 'error'
    };
  }
}
