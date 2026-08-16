import { readdirSync } from 'node:fs';

export type QualityCheckId =
  | 'actionlint'
  | 'cli-docs-contract'
  | 'diff-hygiene'
  | 'docs-build'
  | 'docs-dependencies'
  | 'docs-specs'
  | 'docs-typecheck'
  | 'generated-cli-docs'
  | 'go-race'
  | 'go-test'
  | 'go-vet'
  | 'locked-root-dependencies'
  | 'mobile-build'
  | 'mobile-dependencies'
  | 'package-manager-policy'
  | 'project-build'
  | 'rust-clippy'
  | 'rust-format'
  | 'rust-tests'
  | 'shell-syntax'
  | 'tests'
  | 'typecheck'
  | 'web-build';

export type QualityCheck = {
  command: string[];
  cwd?: string;
  id: QualityCheckId;
};

export const preCommitCheckIds: QualityCheckId[] = [
  'diff-hygiene',
  'package-manager-policy',
  'docs-specs',
];

export function sharedCheckCommand(id: QualityCheckId) {
  return ['bun', 'run', 'ci:check', '--', id];
}

export function resolveQualityCheck(
  id: QualityCheckId,
  options: { diffRange?: string; staged?: boolean } = {},
): QualityCheck {
  const checks: Record<QualityCheckId, Omit<QualityCheck, 'id'>> = {
    get actionlint() {
      return {
        command: [
          'go',
          'run',
          'github.com/rhysd/actionlint/cmd/actionlint@v1.7.7',
          '-shellcheck',
          'shellcheck -S error',
          ...workflowFiles(),
        ],
      };
    },
    'cli-docs-contract': {
      command: [
        'go',
        'test',
        './cmd/project',
        '-run',
        'CLIDocs|RootCommandIncludesExpectedCommands',
      ],
    },
    'diff-hygiene': {
      command: options.staged
        ? ['git', 'diff', '--cached', '--check']
        : options.diffRange
          ? ['git', 'diff', '--check', options.diffRange]
          : ['git', 'diff', '--check'],
    },
    'docs-build': {
      command: ['bun', 'run', 'build'],
      cwd: 'apps/docs',
    },
    'docs-dependencies': {
      command: ['bun', 'install', '--frozen-lockfile'],
      cwd: 'apps/docs',
    },
    'docs-specs': {
      command: [
        'bun',
        'run',
        'docs:specs:check',
        ...(options.staged ? ['--staged', '--base', 'origin/main'] : []),
      ],
    },
    'docs-typecheck': {
      command: ['bun', 'run', 'typecheck'],
      cwd: 'apps/docs',
    },
    'generated-cli-docs': {
      command: ['bun', 'run', 'docs:cli:check'],
    },
    'go-race': {
      command: ['go', 'test', '-race', './...'],
    },
    'go-test': {
      command: ['go', 'test', './...'],
    },
    'go-vet': {
      command: ['go', 'vet', './...'],
    },
    'locked-root-dependencies': {
      command: ['bun', 'install', '--frozen-lockfile'],
    },
    'mobile-build': {
      command: ['bun', 'run', 'build:prototype'],
      cwd: 'apps/mobile',
    },
    'mobile-dependencies': {
      command: ['bun', 'install', '--frozen-lockfile'],
      cwd: 'apps/mobile',
    },
    'package-manager-policy': {
      command: [
        'bun',
        'run',
        'check:package-manager',
        ...(options.staged ? ['--staged'] : []),
      ],
    },
    'project-build': {
      command: ['bun', 'run', 'build'],
    },
    'rust-clippy': {
      command: [
        'cargo',
        '+1.90.0',
        'clippy',
        '--manifest-path',
        'project-hostd/Cargo.toml',
        '--locked',
        '--',
        '-D',
        'warnings',
      ],
    },
    'rust-format': {
      command: [
        'cargo',
        '+1.90.0',
        'fmt',
        '--manifest-path',
        'project-hostd/Cargo.toml',
        '--',
        '--check',
      ],
    },
    'rust-tests': {
      command: [
        'cargo',
        '+1.90.0',
        'test',
        '--manifest-path',
        'project-hostd/Cargo.toml',
        '--locked',
      ],
    },
    get 'shell-syntax'() {
      return { command: ['bash', '-n', ...trackedShellScripts()] };
    },
    tests: {
      command: ['bun', 'test', '--isolate'],
    },
    typecheck: {
      command: ['bun', 'run', 'check'],
    },
    'web-build': {
      command: ['bun', 'run', 'build:web'],
    },
  };
  const check = checks[id];
  if (!check) throw new Error(`Unknown quality check: ${id}`);
  return { id, ...check };
}

export function qualityCheckIds(): QualityCheckId[] {
  return [
    'diff-hygiene',
    'package-manager-policy',
    'docs-specs',
    'locked-root-dependencies',
    'tests',
    'typecheck',
    'web-build',
    'project-build',
    'generated-cli-docs',
    'cli-docs-contract',
    'docs-dependencies',
    'docs-typecheck',
    'docs-build',
    'mobile-dependencies',
    'mobile-build',
    'go-test',
    'go-race',
    'go-vet',
    'rust-format',
    'rust-clippy',
    'rust-tests',
    'actionlint',
    'shell-syntax',
  ];
}

function trackedShellScripts() {
  const result = Bun.spawnSync(['git', 'ls-files', '-z', '*.sh'], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().split('\0').filter(Boolean).sort();
}

function workflowFiles() {
  return readdirSync('.github/workflows')
    .filter((path) => path.endsWith('.yml') || path.endsWith('.yaml'))
    .map((path) => `.github/workflows/${path}`)
    .sort();
}
