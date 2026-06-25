import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

const projectsRoot = process.env.PROJECT_SPACE_PROJECTS_ROOT ?? join(homedir(), 'projects');
const outputPath = new URL('../src/data/project-inventory.ts', import.meta.url);
const publicJsonPath = new URL('../public/project-inventory.json', import.meta.url);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    }).trim();
  } catch {
    return '';
  }
}

function hasFile(dir, names) {
  return names.some((name) => existsSync(join(dir, name)));
}

function findGitProjects(root) {
  const projects = [];
  const queue = [root];
  const visited = new Set();

  while (queue.length > 0) {
    const dir = queue.shift();
    if (!dir || visited.has(dir)) {
      continue;
    }
    visited.add(dir);

    if (existsSync(join(dir, '.git'))) {
      projects.push(dir);
      continue;
    }

    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'Library' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }

      const child = join(dir, entry.name);
      const depth = relative(root, child).split('/').length;
      if (depth <= 3) {
        queue.push(child);
      }
    }
  }

  return projects;
}

function readPackage(projectDir) {
  return readJson(join(projectDir, 'package.json'));
}

function detectStack(projectDir, pkg) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const stack = [];

  if (deps.expo || deps['react-native']) stack.push('React Native');
  if (deps.react || deps['react-dom']) stack.push('React');
  if (deps.electron) stack.push('Electron');
  if (deps.vite) stack.push('Vite');
  if (deps.next) stack.push('Next.js');
  if (deps.tailwindcss) stack.push('Tailwind');
  if (hasFile(projectDir, ['go.mod'])) stack.push('Go');
  if (hasFile(projectDir, ['Dockerfile', 'compose.yml', 'docker-compose.yml'])) stack.push('Docker');
  if (hasFile(projectDir, ['ansible.cfg']) || existsSync(join(projectDir, 'ansible'))) {
    stack.push('Ansible');
  }
  if (existsSync(join(projectDir, 'ios')) || existsSync(join(projectDir, 'android'))) {
    stack.push('Native app');
  }

  return [...new Set(stack)];
}

function categorize(projectDir, name, stack) {
  const text = `${projectDir} ${name} ${stack.join(' ')}`.toLowerCase();

  if (text.includes('project-space')) return 'Project Space';
  if (text.includes('react native') || text.includes('expo') || text.includes('mobile')) {
    return 'Mobile';
  }
  if (text.includes('private-vps') || text.includes('machine') || text.includes('docker')) {
    return 'VPS / Runtime';
  }
  if (text.includes('agent') || text.includes('codex') || text.includes('sona')) {
    return 'Agents';
  }
  if (name === 'ui' || text.includes('component') || text.includes('design')) {
    return 'UI / Design';
  }
  if (text.includes('idea') || text.includes('note') || text.includes('diary')) {
    return 'Knowledge';
  }

  return 'Apps';
}

function fileUpdatedAt(projectDir) {
  try {
    return statSync(projectDir).mtime.toISOString();
  } catch {
    return null;
  }
}

const projects = findGitProjects(projectsRoot).map((projectDir) => {
  const pkg = readPackage(projectDir);
  const name = pkg?.name ?? projectDir.split('/').at(-1) ?? 'project';
  const stack = detectStack(projectDir, pkg);
  const dirty = Boolean(git(projectDir, ['status', '--porcelain']));
  const branch = git(projectDir, ['branch', '--show-current']) || 'detached';
  const remote = git(projectDir, ['remote', 'get-url', 'origin']);
  const lastCommit = git(projectDir, ['log', '-1', '--format=%cs %s']);

  return {
    branch,
    category: categorize(projectDir, String(name), stack),
    dirty,
    lastCommit,
    name: String(name),
    path: projectDir,
    relativePath: relative(projectsRoot, projectDir) || '.',
    remote,
    scripts: Object.keys(pkg?.scripts ?? {}).slice(0, 8),
    stack,
    updatedAt: fileUpdatedAt(projectDir),
  };
});

projects.sort((a, b) => {
  if (a.category !== b.category) return a.category.localeCompare(b.category);
  return a.name.localeCompare(b.name);
});

const payload = {
  generatedAt: new Date().toISOString(),
  projectsRoot,
  projects,
};

writeFileSync(
  outputPath,
  `export interface ProjectInventoryItem {
  branch: string;
  category: string;
  dirty: boolean;
  lastCommit: string;
  name: string;
  path: string;
  relativePath: string;
  remote: string;
  scripts: string[];
  stack: string[];
  updatedAt: string | null;
}

export interface ProjectInventory {
  generatedAt: string;
  projectsRoot: string;
  projects: ProjectInventoryItem[];
}

export const PROJECT_INVENTORY: ProjectInventory = ${JSON.stringify(payload, null, 2)};
`
);

mkdirSync(new URL('../public', import.meta.url), { recursive: true });
writeFileSync(publicJsonPath, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`Wrote ${projects.length} projects to ${outputPath.pathname}`);
console.log(`Wrote ${projects.length} projects to ${publicJsonPath.pathname}`);
