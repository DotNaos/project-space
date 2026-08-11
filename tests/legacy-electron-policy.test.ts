import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const repositoryRoot = resolve(import.meta.dir, '..');

function source(path: string) {
  return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

describe('legacy Electron policy', () => {
  test('keeps the legacy desktop shell and its packages removed', () => {
    const packageJson = JSON.parse(source('package.json')) as {
      main?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const packages = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };

    expect(existsSync(resolve(repositoryRoot, 'electron'))).toBe(false);
    expect(packageJson.main).toBeUndefined();
    expect(Object.keys(packageJson.scripts ?? {}).some((name) => name.includes('electron')))
      .toBe(false);
    for (const dependency of [
      'electron',
      'react-devtools-core',
      'react-devtools-electron',
      'vite-plugin-electron',
      'vite-plugin-electron-renderer'
    ]) {
      expect(packages[dependency]).toBeUndefined();
    }
  });

  test('keeps Electron out of the shared web build configuration', () => {
    const viteConfig = source('vite.config.ts');
    const nodeConfig = JSON.parse(source('tsconfig.node.json')) as {
      include?: string[];
    };

    expect(viteConfig).not.toContain('vite-plugin-electron');
    expect(viteConfig).not.toContain("mode === 'electron'");
    expect(nodeConfig.include).not.toContain('electron');
  });
});
