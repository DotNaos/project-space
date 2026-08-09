import { describe, expect, test } from 'bun:test';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Codespaces runner devcontainer', () => {
  test('uses the pinned prebuilt image with the required runner toolchain', async () => {
    const devcontainer = JSON.parse(
      await readFile('.devcontainer/devcontainer.json', 'utf8')
    ) as {
      features?: Record<string, unknown>;
      image?: string;
      remoteEnv?: { PATH?: string };
      remoteUser?: string;
    };
    const verification = await readFile('.devcontainer/verify-runner.sh', 'utf8');

    expect(devcontainer.image).toBe(
      'mcr.microsoft.com/devcontainers/javascript-node:24-bookworm@sha256:7f9160225f2e0af7a3531a925358ffebff77e1d03d1628953e4252efd6e7bf2d'
    );
    expect(devcontainer.remoteUser).toBe('node');
    expect(devcontainer.remoteEnv?.PATH).toStartWith('/home/node/');
    expect(devcontainer.features).toEqual({
      'ghcr.io/devcontainers/features/sshd:1': {
        version: 'latest',
      },
    });
    const bootstrap = await readFile('.devcontainer/bootstrap.sh', 'utf8');
    const startRunner = await readFile('.devcontainer/start-runner.sh', 'utf8');
    expect(bootstrap).toContain('missing_packages+=(openssh-server)');
    expect(bootstrap).toContain('missing_packages+=(python3)');
    expect(bootstrap).toContain('missing_packages+=(gh)');
    expect(verification).not.toMatch(/for command_name in [^\n]*\bdocker\b/);
    expect(verification).not.toMatch(/for command_name in [^\n]*\bgo\b/);
    expect(verification).toMatch(
      /for command_name in [^\n]*\bsshd\b/
    );
    expect(startRunner).toContain('.devcontainer/start-codex-daemon.sh');
  });

  test('installs node-gyp without blocking on repository dependencies', async () => {
    const bootstrap = await readFile('.devcontainer/bootstrap.sh', 'utf8');
    const verification = await readFile('.devcontainer/verify-runner.sh', 'utf8');

    expect(bootstrap).toMatch(/readonly node_gyp_version="\d+\.\d+\.\d+"/);
    expect(bootstrap.indexOf('bun add --global')).toBeGreaterThan(-1);
    expect(bootstrap).not.toContain('bun install --frozen-lockfile');
    expect(verification).toMatch(
      /for command_name in [^\n]*\bnode-gyp\b/
    );
    expect(verification).toContain("python3 -c 'import shlex'");
  });

  test('prepares reusable runner tools without blocking Codespace availability', async () => {
    const devcontainer = JSON.parse(
      await readFile('.devcontainer/devcontainer.json', 'utf8')
    ) as {
      onCreateCommand?: string;
      postCreateCommand?: string;
      postStartCommand?: string;
    };
    const bootstrap = await readFile('.devcontainer/bootstrap.sh', 'utf8');

    expect(devcontainer.onCreateCommand).toBe(
      'bash .devcontainer/initialize-runner.sh'
    );
    expect(devcontainer.postCreateCommand).toBe(
      'bash .devcontainer/initialize-runner.sh'
    );
    expect(devcontainer.postStartCommand).toBe(
      'bash .devcontainer/initialize-runner.sh'
    );
    const initializer = await readFile(
      '.devcontainer/initialize-runner.sh',
      'utf8'
    );
    expect(initializer).toContain('nohup bash "${initializer}" --run');
    expect(initializer).toContain('.devcontainer/bootstrap.sh');
    expect(initializer).toContain('.devcontainer/start-runner.sh');
    expect(initializer).toContain('for attempt in 1 2 3');
    expect(bootstrap).not.toContain('.devcontainer/start-runner.sh');
    expect(bootstrap).not.toContain('bun install --frozen-lockfile');
  });

  test('returns immediately while one background initializer finishes', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'codespace-initializer-'));
    const devcontainerRoot = join(fixtureRoot, '.devcontainer');
    const markerPath = join(fixtureRoot, 'marker.log');
    const stateRoot = join(fixtureRoot, 'state');

    try {
      await mkdir(devcontainerRoot, { recursive: true });
      await copyFile(
        '.devcontainer/initialize-runner.sh',
        join(devcontainerRoot, 'initialize-runner.sh')
      );
      await writeFile(
        join(devcontainerRoot, 'bootstrap.sh'),
        `#!/usr/bin/env bash\nsleep 1\nprintf 'bootstrap\\n' >> ${JSON.stringify(markerPath)}\n`
      );
      await writeFile(
        join(devcontainerRoot, 'start-runner.sh'),
        `#!/usr/bin/env bash\nprintf 'runner\\n' >> ${JSON.stringify(markerPath)}\n`
      );

      const environment = {
        ...process.env,
        CODESPACE_NAME: 'fixture-codespace',
        HOME: join(fixtureRoot, 'home'),
        XDG_STATE_HOME: stateRoot,
      };
      const startedAt = performance.now();
      const first = Bun.spawn(
        ['bash', join(devcontainerRoot, 'initialize-runner.sh')],
        { cwd: fixtureRoot, env: environment }
      );
      expect(await first.exited).toBe(0);
      expect(performance.now() - startedAt).toBeLessThan(2_000);

      const duplicate = Bun.spawn(
        ['bash', join(devcontainerRoot, 'initialize-runner.sh')],
        { cwd: fixtureRoot, env: environment }
      );
      expect(await duplicate.exited).toBe(0);

      let marker = '';
      for (let attempt = 0; attempt < 30; attempt += 1) {
        marker = await readFile(markerPath, 'utf8').catch(() => '');
        if (marker.includes('runner')) break;
        await Bun.sleep(100);
      }
      expect(marker).toBe('bootstrap\nrunner\n');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('pins the released connector that retains Codespaces metadata', async () => {
    const bootstrap = await readFile('.devcontainer/bootstrap.sh', 'utf8');

    expect(bootstrap).toContain('readonly project_version="0.10.18"');
    expect(bootstrap).toContain(
      'readonly archive_sha256="056469cbff0cc4ed1d16b446a8223915b01abef08501edc00cac3cb53915b1df"'
    );
    expect(bootstrap).toContain('--external-connector-supervisor');
    expect(bootstrap).toContain('sort -V');
    expect(bootstrap).toContain('project self-update --yes --format json');
    expect(bootstrap).toContain('continuing with pinned v${project_version}');
  });

  test('installs and starts the pinned Codex daemon runtime idempotently', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'codespace-codex-daemon-'));
    const managedRoot = join(
      fixtureRoot,
      '.local/bin/.project-space-machine-tools/current'
    );
    const invocationPath = join(fixtureRoot, 'codex-invocations.log');

    try {
      await mkdir(managedRoot, { recursive: true });
      await writeFile(
        join(managedRoot, 'codex'),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(invocationPath)}\n`,
        { mode: 0o755 }
      );
      const script = '.devcontainer/start-codex-daemon.sh';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const process = Bun.spawn(['bash', script], {
          env: { ...processEnvWithoutApiKeys(), HOME: fixtureRoot },
        });
        expect(await process.exited).toBe(0);
      }

      const standaloneCodex = join(
        fixtureRoot,
        '.codex/packages/standalone/current/codex'
      );
      expect(await readFile(standaloneCodex, 'utf8')).toContain('codex-invocations.log');
      expect(await readFile(invocationPath, 'utf8')).toBe(
        'app-server daemon start\napp-server daemon start\n'
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

function processEnvWithoutApiKeys() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => ![
      'OPENAI_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'CODEX_API_KEY',
    ].includes(key))
  );
}
