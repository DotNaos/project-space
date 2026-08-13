import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { Alias, Plugin } from 'vite';

interface LocalNodeImport {
  specifier: string;
  path: string;
}

interface LocalNodePackage {
  name: string;
  directory: string;
  imports: LocalNodeImport[];
  unsupportedImports?: string[];
  sourceDirectories: string[];
}

interface LocalNodeLibrary {
  directory: string;
  packages: LocalNodePackage[];
}

interface LocalNodeLibrariesManifest {
  version: number;
  libraries: LocalNodeLibrary[];
}

export interface ViteLocalNodeLibraries {
  aliases: Alias[];
  packageNames: string[];
  plugins: Plugin[];
  roots: string[];
}

const emptyConfiguration: ViteLocalNodeLibraries = {
  aliases: [],
  packageNames: [],
  plugins: [],
  roots: []
};

export function viteLocalNodeLibraries(command: 'build' | 'serve'): ViteLocalNodeLibraries {
  const manifestPath = process.env.PROJECT_SERVE_WITH?.trim();
  if (!manifestPath) return emptyConfiguration;
  if (command !== 'serve') {
    throw new Error('Local --with libraries are allowed only for managed development servers.');
  }
  if (process.env.PROJECT_SPACE_MANAGED_SERVE !== '1') {
    throw new Error('Local --with libraries require a managed Project CLI server.');
  }

  const manifest = readManifest(manifestPath);
  const aliases: Alias[] = [];
  const packageNames = new Set<string>();
  const roots = new Set<string>();
  const sourceDirectories = new Set<string>();
  const unsupportedImports = new Set<string>();
  for (const library of manifest.libraries) {
    assertDirectory(library.directory, 'library directory');
    roots.add(library.directory);
    for (const pkg of library.packages) {
      assertDirectory(pkg.directory, `package ${pkg.name}`);
      packageNames.add(pkg.name);
	  for (const specifier of pkg.unsupportedImports ?? []) unsupportedImports.add(specifier);
      for (const sourceDirectory of pkg.sourceDirectories) {
        assertDirectory(sourceDirectory, `source directory for ${pkg.name}`);
        sourceDirectories.add(sourceDirectory);
      }
      for (const entry of pkg.imports) {
        if (!entry.specifier || !isAbsolute(entry.path)) {
          throw new Error(`Local package ${pkg.name} contains an invalid import mapping.`);
        }
        aliases.push({
          find: new RegExp(`^${escapeRegularExpression(entry.specifier)}$`, 'u'),
          replacement: entry.path
        });
      }
    }
  }
  aliases.sort((left, right) => String(right.find).length - String(left.find).length);
  return {
    aliases,
    packageNames: [...packageNames].sort(),
    plugins: [
	  ...(unsupportedImports.size > 0 ? [rejectUnsupportedLocalImports([...unsupportedImports].sort())] : []),
	  ...(sourceDirectories.size > 0 ? [tailwindLocalSources([...sourceDirectories].sort())] : [])
	],
    roots: [...roots].sort()
  };
}

function rejectUnsupportedLocalImports(specifiers: string[]): Plugin {
  const unsupported = new Set(specifiers);
  return {
    name: 'project-local-node-library-unsupported-imports',
    enforce: 'pre',
    resolveId(source) {
      if (unsupported.has(source)) {
        throw new Error(
          `Local package export ${source} has no source mapping. Add a source export or a package watch script.`
        );
      }
    }
  };
}

function readManifest(path: string): LocalNodeLibrariesManifest {
  if (!isAbsolute(path)) throw new Error('PROJECT_SERVE_WITH must be an absolute manifest path.');
  const body = readFileSync(path, 'utf8');
  if (body.length > 4 * 1024 * 1024) throw new Error('Local library manifest exceeds 4 MiB.');
  const value = JSON.parse(body) as Partial<LocalNodeLibrariesManifest>;
  if (value.version !== 1 || !Array.isArray(value.libraries) || value.libraries.length > 16) {
    throw new Error('Local library manifest has an unsupported shape.');
  }
  return value as LocalNodeLibrariesManifest;
}

function assertDirectory(path: string, label: string) {
  if (!isAbsolute(path) || !statSync(path).isDirectory()) {
    throw new Error(`Local ${label} is not an absolute directory: ${path}`);
  }
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function tailwindLocalSources(sourceDirectories: string[]): Plugin {
  const directives = sourceDirectories
    .map((directory) => `@source "${cssString(directory)}";`)
    .join('\n');
  return {
    name: 'project-local-node-library-tailwind-sources',
    enforce: 'pre',
    transform(code, id) {
      const path = id.split('?', 1)[0];
      if (!path.endsWith('.css') || !code.includes('@import "tailwindcss"')) return;
      return `${code}\n${directives}\n`;
    }
  };
}

function cssString(value: string) {
  return resolve(value).replaceAll('\\', '/').replaceAll('"', '\\"');
}
