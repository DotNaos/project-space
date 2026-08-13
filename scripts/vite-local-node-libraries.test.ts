import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from 'vite';

import { viteLocalNodeLibraries } from './vite-local-node-libraries';

const temporaryRoots: string[] = [];
const originalManifest = process.env.PROJECT_SERVE_WITH;
const originalManagedServe = process.env.PROJECT_SPACE_MANAGED_SERVE;

afterEach(() => {
  restoreEnvironment('PROJECT_SERVE_WITH', originalManifest);
  restoreEnvironment('PROJECT_SPACE_MANAGED_SERVE', originalManagedServe);
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('serves two local libraries and observes source edits without reinstalling', async () => {
  const root = temporaryDirectory();
  const consumer = join(root, 'consumer');
  const first = writeSourceLibrary(root, 'first', '@example/first', 'first-v1');
  const second = writeSourceLibrary(root, 'second', '@example/second', 'second-v1');
  mkdirSync(join(consumer, 'src'), { recursive: true });
  writeFileSync(join(consumer, 'package.json'), '{"name":"consumer","private":true}\n');
  writeFileSync(join(consumer, 'bun.lock'), 'fixture-lock\n');
  writeFileSync(join(consumer, 'index.html'), '<script type="module" src="/src/main.ts"></script>\n');
  writeFileSync(
    join(consumer, 'src/main.ts'),
    "import { first } from '@example/first';\nimport { second } from '@example/second';\nconsole.log(first, second);\n"
  );
  const originalPackage = readFileSync(join(consumer, 'package.json'));
  const originalLock = readFileSync(join(consumer, 'bun.lock'));
  const manifestPath = join(root, 'libraries.json');
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    libraries: [libraryManifest(first, '@example/first'), libraryManifest(second, '@example/second')]
  }));
  process.env.PROJECT_SERVE_WITH = manifestPath;
  process.env.PROJECT_SPACE_MANAGED_SERVE = '1';
  const local = viteLocalNodeLibraries('serve');
  const server = await createServer({
    configFile: false,
    root: consumer,
    logLevel: 'silent',
    plugins: local.plugins,
    resolve: { alias: local.aliases },
    server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [consumer, ...local.roots] } }
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not expose a TCP address.');
    const origin = `http://127.0.0.1:${address.port}`;
	await responseText(`${origin}/src/main.ts`);
	const importer = join(consumer, 'src/main.ts');
	expect((await server.pluginContainer.resolveId('@example/first', importer))?.id).toBe(join(first, 'src/index.ts'));
	expect((await server.pluginContainer.resolveId('@example/second', importer))?.id).toBe(join(second, 'src/index.ts'));
    expect(await responseText(sourceURL(origin, first))).toContain('first-v1');
    expect(await responseText(sourceURL(origin, second))).toContain('second-v1');

    writeFileSync(join(first, 'src/index.ts'), "export const first = 'first-v2';\n");
    await expectEventually(async () => (await responseText(sourceURL(origin, first))).includes('first-v2'));
    expect(await responseText(sourceURL(origin, second))).toContain('second-v1');
  } finally {
    await server.close();
  }
  expect(readFileSync(join(consumer, 'package.json'))).toEqual(originalPackage);
  expect(readFileSync(join(consumer, 'bun.lock'))).toEqual(originalLock);
});

test('injects local sources into Tailwind and rejects build use', async () => {
  const root = temporaryDirectory();
  const library = writeSourceLibrary(root, 'ui', '@example/ui', 'ui-v1');
  const manifestPath = join(root, 'libraries.json');
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    libraries: [libraryManifest(library, '@example/ui')]
  }));
  process.env.PROJECT_SERVE_WITH = manifestPath;
  process.env.PROJECT_SPACE_MANAGED_SERVE = '1';
  const local = viteLocalNodeLibraries('serve');
  const hook = local.plugins[0]?.transform;
  if (!hook) throw new Error('Tailwind source plugin is missing.');
  const transform = typeof hook === 'function' ? hook : hook.handler;
  const transformed = await transform.call({} as never, '@import "tailwindcss";\n', '/tmp/app.css', {} as never);
  expect(String(transformed)).toContain(`@source "${join(library, 'src')}";`);
  expect(() => viteLocalNodeLibraries('build')).toThrow('allowed only for managed development servers');
});

function writeSourceLibrary(root: string, directory: string, name: string, value: string) {
  const library = join(root, directory);
  mkdirSync(join(library, 'src'), { recursive: true });
  writeFileSync(join(library, 'src/index.ts'), `export const ${directory} = '${value}';\n`);
  return library;
}

function libraryManifest(directory: string, name: string) {
  return {
    directory,
    packages: [{
      name,
      directory,
      imports: [{ specifier: name, path: join(directory, 'src/index.ts') }],
      sourceDirectories: [join(directory, 'src')]
    }]
  };
}

function sourceURL(origin: string, directory: string) {
  return `${origin}/@fs${join(directory, 'src/index.ts')}?t=${Date.now()}`;
}

async function responseText(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.text();
}

async function expectEventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error('Timed out waiting for the local source update.');
}

function temporaryDirectory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'project-local-node-libraries-')));
  temporaryRoots.push(root);
  return root;
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
