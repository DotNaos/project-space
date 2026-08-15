import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { validateInternalDocsLinks } from './links';

export type Diagnostic = {
  line?: number;
  message: string;
  path: string;
};

export type ValidationReport = {
  changes: number;
  diagnostics: Diagnostic[];
  requirements: number;
  templates: number;
};

type Task = {
  checked: boolean;
  children: Task[];
  indent: number;
  line: number;
  metadata: Map<string, string>;
  parent?: Task;
  section: string;
  text: string;
};

type ChangeValidation = {
  diagnostics: Diagnostic[];
  issueNumbers: number[];
  requirementIds: string[];
};

const artifactNames = [
  'proposal',
  'requirements',
  'design',
  'tasks',
  'verification',
] as const;

const requiredNavigation = [
  'getting-started',
  'product',
  'architecture',
  'decisions',
  'development',
  'operations',
  'reference',
];

export function validateRepository(root = process.cwd()): ValidationReport {
  const diagnostics: Diagnostic[] = [];
  const docsRoot = join(root, 'apps/docs/content/docs');
  const changesRoot = join(docsRoot, 'development/changes');
  const templateRoot = join(root, 'apps/docs/content/change-template');

  diagnostics.push(...validateNavigation(docsRoot));
  diagnostics.push(...validateInternalDocsLinks(docsRoot, root));

  let requirements = 0;
  const currentRequirementIds = new Map<string, string>();
  for (const path of markdownFiles(join(docsRoot, 'product'))) {
    const result = validateRequirementDocument(read(path), relative(root, path), false);
    diagnostics.push(...result.diagnostics);
    requirements += result.ids.length;
    for (const id of result.ids) {
      const existing = currentRequirementIds.get(id);
      if (existing) {
        diagnostics.push(error(relative(root, path), `Current requirement ${id} is already declared in ${existing}.`));
      } else {
        currentRequirementIds.set(id, relative(root, path));
      }
    }
  }

  let changes = 0;
  if (!existsSync(changesRoot)) {
    diagnostics.push(error(relative(root, changesRoot), 'Change-spec directory is missing.'));
  } else {
    for (const path of changeDirectories(changesRoot)) {
      changes += 1;
      diagnostics.push(...validateChangeDirectory(path, root, '.mdx').diagnostics);
    }
  }

  const template = validateChangeDirectory(templateRoot, root, '.md', true);
  diagnostics.push(...template.diagnostics);

  return {
    changes,
    diagnostics: sortDiagnostics(diagnostics),
    requirements,
    templates: template.diagnostics.length === 0 ? 1 : 0,
  };
}

export function validateChangeDirectory(
  directory: string,
  repositoryRoot = process.cwd(),
  extension = '.mdx',
  template = false,
): ChangeValidation {
  const diagnostics: Diagnostic[] = [];
  const sources = new Map<string, { path: string; source: string }>();

  for (const name of artifactNames) {
    const path = join(directory, `${name}${extension}`);
    if (!existsSync(path)) {
      diagnostics.push(error(relative(repositoryRoot, path), `Required ${name} artifact is missing.`));
      continue;
    }
    sources.set(name, { path: relative(repositoryRoot, path), source: read(path) });
  }
  if (sources.size !== artifactNames.length) {
    return { diagnostics, issueNumbers: [], requirementIds: [] };
  }

  const proposal = sources.get('proposal')!;
  const requirements = sources.get('requirements')!;
  const design = sources.get('design')!;
  const tasks = sources.get('tasks')!;
  const verification = sources.get('verification')!;

  diagnostics.push(...validateProposal(proposal.source, proposal.path, template));
  const status = changeStatus(proposal.source);
  const requirementResult = validateRequirementDocument(
    requirements.source,
    requirements.path,
    true,
  );
  diagnostics.push(...requirementResult.diagnostics);
  diagnostics.push(...validateDesign(design.source, design.path));
  diagnostics.push(...validateTasks(tasks.source, tasks.path, status === 'complete' || status === 'archived'));
  diagnostics.push(...validateVerification(
    verification.source,
    verification.path,
    requirementResult.ids,
    status,
    template,
  ));

  const issueNumbers = [...sources.values()]
    .flatMap(({ source }) => [...source.matchAll(/#([1-9][0-9]*)\b/g)].map((match) => Number(match[1])))
    .filter((number, index, all) => all.indexOf(number) === index)
    .sort((a, b) => a - b);

  return { diagnostics, issueNumbers, requirementIds: requirementResult.ids };
}

export function validateRequirementDocument(
  source: string,
  path: string,
  delta: boolean,
) {
  const diagnostics: Diagnostic[] = [];
  const plain = stripIgnoredContent(source);
  if (delta) {
    const hasDelta = ['ADDED', 'CHANGED', 'REMOVED'].some((operation) =>
      new RegExp(`^## ${operation} Requirements$`, 'm').test(plain),
    );
    const notApplicable = /^Requirements:\s+\*\*Not applicable\*\*/mi.test(plain);
    if (!hasDelta && !notApplicable) {
      diagnostics.push(error(path, 'Requirement delta must declare ADDED, CHANGED, or REMOVED Requirements.'));
    }
    if (notApplicable && !/^## Requirements rationale$/m.test(plain)) {
      diagnostics.push(error(path, 'A not-applicable requirement delta needs a Requirements rationale section.'));
    }
  }

  const headings = [...plain.matchAll(/^### ([A-Z][A-Z0-9-]+) — (.+)$/gm)];
  const ids: string[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const id = heading[1];
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? plain.length;
    const section = plain.slice(start, end);
    const line = lineNumber(plain, start);
    if (ids.includes(id)) diagnostics.push(error(path, `Requirement ${id} is duplicated.`, line));
    ids.push(id);
    if (!/\bMUST(?: NOT)?\b/.test(section)) {
      diagnostics.push(error(path, `Requirement ${id} must contain normative MUST language.`, line));
    }
    const scenarios = [...section.matchAll(/^#### Scenario: .+$/gm)];
    if (scenarios.length === 0) {
      diagnostics.push(error(path, `Requirement ${id} needs at least one Scenario.`, line));
    }
    for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
      const scenario = scenarios[scenarioIndex];
      const scenarioStart = scenario.index ?? 0;
      const scenarioEnd = scenarios[scenarioIndex + 1]?.index ?? section.length;
      const body = section.slice(scenarioStart, scenarioEnd);
      for (const keyword of ['Given', 'When', 'Then']) {
        if (!new RegExp(`^- \\*\\*${keyword}\\*\\*`, 'm').test(body)) {
          diagnostics.push(error(
            path,
            `${scenario[0]} for ${id} is missing a ${keyword} step.`,
            lineNumber(plain, start + scenarioStart),
          ));
        }
      }
    }
  }
  return { diagnostics, ids };
}

export function validateTasks(source: string, path: string, completedChange: boolean) {
  const diagnostics: Diagnostic[] = [];
  const tasks = parseTasks(source);
  if (tasks.length === 0) return [error(path, 'Tasks artifact needs at least one checklist item.')];

  for (const task of tasks) {
    const descendants = flatten(task.children);
    if (task.checked && descendants.some((child) => !child.checked)) {
      diagnostics.push(error(path, `Completed parent task "${task.text}" contains an incomplete descendant.`, task.line));
    }
    if (task.checked && task.children.length === 0 && !task.metadata.get('evidence')) {
      diagnostics.push(error(path, `Completed leaf task "${task.text}" needs Evidence.`, task.line));
    }
    const number = /^(\d+(?:\.\d+)+)\s+/.exec(task.text)?.[1];
    if (number && number.split('.').length > 3) {
      diagnostics.push(error(path, `Task numbering should not exceed three levels: ${number}.`, task.line));
    }
    const sectionNumber = /^(\d+)\./.exec(task.section)?.[1];
    if (number && sectionNumber && number.split('.')[0] !== sectionNumber) {
      diagnostics.push(error(path, `Task ${number} does not belong under section ${sectionNumber}.`, task.line));
    }

    const blocked = task.metadata.get('status')?.toLowerCase() === 'blocked';
    if (blocked) {
      if (task.checked) diagnostics.push(error(path, `Blocked task "${task.text}" cannot be complete.`, task.line));
      for (const field of ['reason', 'blocked by', 'unblocked when']) {
        if (!task.metadata.get(field)) diagnostics.push(error(path, `Blocked task "${task.text}" needs ${title(field)}.`, task.line));
      }
      const dependency = task.metadata.get('blocked by');
      if (dependency && !/^(?:#[1-9][0-9]*|\d+(?:\.\d+){1,2})$/.test(dependency)) {
        diagnostics.push(error(path, `Blocked by must reference a GitHub issue or numbered task: ${dependency}.`, task.line));
      }
    }
    if (task.metadata.has('continue in') && !/^#[1-9][0-9]*$/.test(task.metadata.get('continue in')!)) {
      diagnostics.push(error(path, `Continue in must reference a GitHub issue for "${task.text}".`, task.line));
    }

    const deferred = /deferred follow-ups/i.test(task.section);
    if (deferred && !task.parent) {
      for (const field of ['issue', 'reason', 'acceptance criteria']) {
        if (!task.metadata.get(field)) diagnostics.push(error(path, `Deferred task "${task.text}" needs ${title(field)}.`, task.line));
      }
      const issue = task.metadata.get('issue');
      if (issue && !/^#[1-9][0-9]*$/.test(issue)) {
        diagnostics.push(error(path, `Deferred Issue must be a GitHub issue number for "${task.text}".`, task.line));
      }
    }
    if (completedChange && !deferred && !task.checked) {
      diagnostics.push(error(path, `Completed change still has required open task "${task.text}".`, task.line));
    }
  }
  return diagnostics;
}

function validateNavigation(docsRoot: string) {
  const path = join(docsRoot, 'meta.json');
  if (!existsSync(path)) return [error(path, 'Primary docs navigation is missing.')];
  const source = read(path);
  return requiredNavigation
    .filter((page) => !source.includes(`"${page}"`))
    .map((page) => error(path, `Primary docs navigation is missing ${page}.`));
}

function validateProposal(source: string, path: string, template: boolean) {
  const diagnostics: Diagnostic[] = [];
  for (const heading of ['Summary', 'Problem', 'Scope', 'Out of scope', 'Delivery']) {
    if (!new RegExp(`^## ${escapeRegExp(heading)}$`, 'm').test(source)) {
      diagnostics.push(error(path, `Proposal is missing the ${heading} section.`));
    }
  }
  for (const field of ['Change status', 'Change kind', 'Issue', 'Requirements']) {
    if (!new RegExp(`^${field}:`, 'm').test(source)) diagnostics.push(error(path, `Proposal is missing ${field}.`));
  }
  if (!template && !changeStatus(source)) diagnostics.push(error(path, 'Change status must be Proposed, Active, Blocked, Complete, or Archived.'));
  if (/^Requirements:\s+\*\*Not applicable\*\*/mi.test(source) && !/^## Requirements rationale$/m.test(source)) {
    diagnostics.push(error(path, 'Requirements marked not applicable need a Requirements rationale section.'));
  }
  return diagnostics;
}

function validateDesign(source: string, path: string) {
  const diagnostics: Diagnostic[] = [];
  for (const heading of [
    'Context',
    'Goals and non-goals',
    'Architecture',
    'Decisions',
    'Risks and mitigations',
    'Migration and rollout',
    'Validation',
  ]) {
    if (!new RegExp(`^## ${escapeRegExp(heading)}$`, 'm').test(source)) diagnostics.push(error(path, `Design is missing the ${heading} section.`));
  }
  return diagnostics;
}

function validateVerification(
  source: string,
  path: string,
  requirementIds: string[],
  status: string | undefined,
  template: boolean,
) {
  const diagnostics: Diagnostic[] = [];
  for (const heading of ['Requirement evidence', 'Final reconciliation']) {
    if (!new RegExp(`^## ${heading}$`, 'm').test(source)) diagnostics.push(error(path, `Verification is missing ${heading}.`));
  }
  for (const id of requirementIds) {
    if (!source.includes(id)) diagnostics.push(error(path, `Verification does not reconcile requirement ${id}.`));
  }
  const verificationStatus = /Verification status:\s+\*\*(Incomplete|Complete)\*\*/i.exec(source)?.[1]?.toLowerCase();
  if (!verificationStatus) diagnostics.push(error(path, 'Verification status must be Incomplete or Complete.'));
  const completed = status === 'complete' || status === 'archived';
  if (!template && completed && verificationStatus !== 'complete') {
    diagnostics.push(error(path, 'A completed change needs Complete verification status.'));
  }
  if (!template && completed) {
    for (const match of source.matchAll(/^- \[ \] (.+)$/gm)) {
      diagnostics.push(error(path, `Completed verification still has open item "${match[1]}".`, lineNumber(source, match.index ?? 0)));
    }
  }
  return diagnostics;
}

function parseTasks(source: string) {
  const tasks: Task[] = [];
  const stack: Task[] = [];
  let section = '';
  let fenced = false;
  let comment = false;
  const lines = source.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (line.includes('<!--')) comment = true;
    if (fenced || comment) {
      if (line.includes('-->')) comment = false;
      continue;
    }
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      section = heading[1];
      stack.length = 0;
      continue;
    }
    const match = /^(\s*)- \[([ xX])\] (.+)$/.exec(line);
    if (match) {
      const indent = match[1].replace(/\t/g, '  ').length;
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      const parent = stack.at(-1);
      const task: Task = {
        checked: match[2].toLowerCase() === 'x',
        children: [],
        indent,
        line: index + 1,
        metadata: new Map(),
        parent,
        section,
        text: match[3].trim(),
      };
      if (parent) parent.children.push(task);
      tasks.push(task);
      stack.push(task);
      continue;
    }
    const metadata = /^(\s*)- \*\*(Evidence|Status|Reason|Blocked by|Unblocked when|Continue in|Issue|Acceptance criteria):\*\*\s*(.+)$/i.exec(line);
    if (metadata) {
      const indent = metadata[1].replace(/\t/g, '  ').length;
      const target = [...stack].reverse().find((task) => task.indent < indent);
      if (target) target.metadata.set(metadata[2].toLowerCase(), metadata[3].trim());
    }
  }
  return tasks;
}

function markdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && /\.mdx?$/.test(entry.name) ? [path] : [];
  }).sort();
}

function changeDirectories(root: string) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const path = join(root, entry.name);
    if (entry.name !== 'archive') return [path];
    return readdirSync(path, { withFileTypes: true })
      .filter((archived) => archived.isDirectory())
      .map((archived) => join(path, archived.name));
  }).sort();
}

function stripIgnoredContent(source: string) {
  return source
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function changeStatus(source: string) {
  return /Change status:\s+\*\*(Proposed|Active|Blocked|Complete|Archived)\*\*/i.exec(source)?.[1]?.toLowerCase();
}

function flatten(tasks: Task[]): Task[] {
  return tasks.flatMap((task) => [task, ...flatten(task.children)]);
}

function error(path: string, message: string, line?: number): Diagnostic {
  return { line, message, path };
}

function lineNumber(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}

function title(value: string) {
  return value.replace(/^./, (character) => character.toUpperCase());
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function read(path: string) {
  return readFileSync(path, 'utf8');
}

function sortDiagnostics(diagnostics: Diagnostic[]) {
  return diagnostics.sort((left, right) =>
    left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0) || left.message.localeCompare(right.message),
  );
}

export function behaviorSensitivePaths(paths: string[]) {
  const prefixes = [
    'apps/mobile/',
    'apps/prototype/',
    'cmd/',
    'deploy/',
    'internal/',
    'migrations/',
    'packages/',
    'project-hostd/',
    'server/',
    'src/',
  ];
  return paths.filter((path) => prefixes.some((prefix) => path.startsWith(prefix)));
}

export function changedChangeArtifacts(paths: string[]) {
  return paths.filter((path) =>
    /^apps\/docs\/content\/docs\/development\/changes\/(?:archive\/)?[^/]+\/(proposal|requirements|design|tasks|verification)\.mdx$/.test(path),
  );
}
