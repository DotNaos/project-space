import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

type LinkDiagnostic = {
  line?: number;
  message: string;
  path: string;
};

export function validateInternalDocsLinks(
  docsRoot: string,
  repositoryRoot: string,
): LinkDiagnostic[] {
  if (!existsSync(docsRoot)) return [];
  const files = markdownFiles(docsRoot).filter((path) => !path.includes('/releases/entries/'));
  const routes = new Set(files.map((path) => routeFor(path, docsRoot)));
  routes.add('/docs/changelog');

  const diagnostics: LinkDiagnostic[] = [];
  for (const path of files) {
    const source = stripIgnoredContent(readFileSync(path, 'utf8'));
    for (const match of source.matchAll(/\]\((\/docs(?:\/[^)\s#?]*)?)(?:[?#][^)]*)?\)/g)) {
      const route = match[1].replace(/\/$/, '') || '/docs';
      if (!routes.has(route)) {
        diagnostics.push({
          line: lineNumber(source, match.index ?? 0),
          message: `Internal docs link points to missing route ${route}.`,
          path: relative(repositoryRoot, path),
        });
      }
    }
  }
  return diagnostics;
}

function routeFor(path: string, docsRoot: string) {
  const sourcePath = relative(docsRoot, path).replace(/\.mdx?$/, '');
  if (sourcePath === 'index') return '/docs';
  return `/docs/${sourcePath.replace(/\/index$/, '')}`;
}

function markdownFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && /\.mdx?$/.test(entry.name) ? [path] : [];
  });
}

function stripIgnoredContent(source: string) {
  return source
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function lineNumber(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}
