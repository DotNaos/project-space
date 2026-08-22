import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript-ui-copy-audit';

// Synced from DotNaos/ui at fc3d959cfa24048a72621b1484d164e99e42fe85.
// Project Space adds its root `src` tree to the upstream application/package roots.
const sourceRoots = ['apps', 'components', 'packages', 'src'] as const;
const ignoredDirectoryNames = new Set([
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'dist-prototype',
  'generated',
  'node_modules',
  'public',
]);
const ignoredFilePatterns = [
  /\.d\.ts$/,
  /\.spec\.[jt]sx?$/,
  /\.test\.[jt]sx?$/,
  /\.type-test\.[jt]sx?$/,
];
const visiblePropertyNames = new Set([
  'accessibilityLabel',
  'aria-label',
  'caption',
  'children',
  'description',
  'emptyLabel',
  'errorMessage',
  'heading',
  'helperText',
  'label',
  'message',
  'placeholder',
  'text',
  'title',
]);
const classPropertyNames = new Set(['class', 'className']);
const allowedAcronyms = new Set([
  'AI',
  'API',
  'CSS',
  'CPU',
  'DOM',
  'GA',
  'GPU',
  'GPT-5.4',
  'GPT-5.5',
  'GUID',
  'HTML',
  'HTTP',
  'HTTPS',
  'ID',
  'JSON',
  'JS',
  'JSX',
  'JWT',
  'KSUID',
  'MCP',
  'NPM',
  'OS',
  'PDF',
  'PC',
  'PR',
  'PS',
  'RAM',
  'REM',
  'SDK',
  'SSH',
  'SSD',
  'TS',
  'TSX',
  'UI',
  'ULID',
  'URL',
  'UUID',
  'UX',
  'VPS',
  'XML',
  'XID',
]);

export type UiCopyWarningCode = 'full-caps-copy' | 'uppercase-copy-style';

export interface UiCopyWarning {
  code: UiCopyWarningCode;
  column: number;
  filePath: string;
  line: number;
  text: string;
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function isSourceFile(filePath: string): boolean {
  return /\.[jt]sx?$/.test(filePath)
    && !ignoredFilePatterns.some((pattern) => pattern.test(filePath));
}

function listSourceFiles(repoRoot: string): string[] {
  const files: string[] = [];

  const visitDirectory = (directoryPath: string): void => {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name)) visitDirectory(entryPath);
      } else if (entry.isFile() && isSourceFile(entryPath)) {
        files.push(entryPath);
      }
    }
  };

  for (const sourceRoot of sourceRoots) {
    const root = path.join(repoRoot, sourceRoot);
    if (existsSync(root)) visitDirectory(root);
  }

  return files.sort();
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }

  return undefined;
}

function staticText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isJsxText(node)) return node.text.replace(/\s+/g, ' ').trim();
  if (ts.isJsxExpression(node)) return staticText(node.expression);
  return undefined;
}

function isFullCapsCopy(value: string): boolean {
  const text = value.trim();
  if (!text || allowedAcronyms.has(text)) return false;

  const letters = Array.from(text).filter((character) => /\p{L}/u.test(character)).join('');
  return letters.length >= 2
    && letters === letters.toLocaleUpperCase('en')
    && letters !== letters.toLocaleLowerCase('en');
}

function containsUppercaseUtility(node: ts.Node | undefined): boolean {
  if (!node) return false;
  let found = false;

  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) {
      found = candidate.text.split(/\s+/).includes('uppercase');
      return;
    }
    if (ts.isTemplateExpression(candidate)) {
      const text = [candidate.head.text, ...candidate.templateSpans.map((span) => span.literal.text)].join(' ');
      found = text.split(/\s+/).includes('uppercase');
      if (found) return;
    }
    ts.forEachChild(candidate, visit);
  };

  visit(node);
  return found;
}

function looksLikeTailwindClassList(node: ts.Node | undefined): boolean {
  const text = staticText(node);
  if (!text) return false;

  const tokens = text.split(/\s+/);
  return tokens.includes('uppercase') && tokens.some((token) => (
    /^(?:[a-z-]+:)*(?:bg|border|flex|font|gap|grid|inline|items|justify|leading|m[trblxy]?|p[trblxy]?|rounded|text|tracking)-/.test(token)
  ));
}

function sourcePosition(sourceFile: ts.SourceFile, node: ts.Node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { column: position.character + 1, line: position.line + 1 };
}

export function inspectUiCopySource(filePath: string, source: string): UiCopyWarning[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const warnings: UiCopyWarning[] = [];

  const addWarning = (code: UiCopyWarningCode, node: ts.Node, text: string): void => {
    warnings.push({ code, filePath: normalizePath(filePath), text, ...sourcePosition(sourceFile, node) });
  };

  const inspectVisibleText = (node: ts.Node | undefined): void => {
    const text = staticText(node);
    if (text && isFullCapsCopy(text) && node) addWarning('full-caps-copy', node, text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      inspectVisibleText(node);
    } else if (ts.isJsxExpression(node) && node.parent && ts.isJsxElement(node.parent)) {
      inspectVisibleText(node);
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (visiblePropertyNames.has(name)) inspectVisibleText(node.initializer);
      if (classPropertyNames.has(name) && containsUppercaseUtility(node.initializer)) {
        addWarning('uppercase-copy-style', node, 'uppercase');
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name && visiblePropertyNames.has(name)) inspectVisibleText(node.initializer);
      if (name && classPropertyNames.has(name) && containsUppercaseUtility(node.initializer)) {
        addWarning('uppercase-copy-style', node, 'uppercase');
      } else if (name === 'textTransform' && staticText(node.initializer) === 'uppercase') {
        addWarning('uppercase-copy-style', node, 'textTransform: uppercase');
      } else if (looksLikeTailwindClassList(node.initializer)) {
        addWarning('uppercase-copy-style', node, 'uppercase');
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return warnings;
}

export function findUiCopyWarnings(repoRoot: string): UiCopyWarning[] {
  return listSourceFiles(repoRoot).flatMap((absolutePath) => {
    const relativePath = normalizePath(path.relative(repoRoot, absolutePath));
    return inspectUiCopySource(relativePath, readFileSync(absolutePath, 'utf8'));
  });
}

export function exceedsWarningLimit(warningCount: number, maxWarnings: number): boolean {
  return warningCount > maxWarnings;
}
