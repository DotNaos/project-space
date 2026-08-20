import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { validateTasksDocument } from '../plugins/project-space/skills/project-manager/scripts/validate-tasks';

const root = new URL('..', import.meta.url).pathname;

test('versioned Project Manager skill owns completion and Preview dogfooding', async () => {
  const skill = await readFile(`${root}plugins/project-space/skills/project-manager/SKILL.md`, 'utf8');
  const agents = await readFile(`${root}AGENTS.md`, 'utf8');
  expect(skill).toContain('version: 1.1.0');
  for (const phrase of [
    'main` is a read-only Project Manager surface',
    'gpt-5.6-luna` with high reasoning',
    'Keep at most three active implementation workers',
    'The Project Manager is the only task that communicates with the user',
    'every 30 minutes',
    'idle, interrupted, failed, timed-out, or completed worker turn is an event',
    'inspect the exact PR head',
    'exact-head Preview',
    'desktop and mobile sizes',
    'same worker task',
    'no Preview-compatible surface',
    'Normal authentication checks, CI and Preview gates',
    'project codex start --issue <number> --environment-id <id> --operation-id <id>',
    'Do not locally run',
    'cea348d649e01bc3bedbcba6b08ee7ae4001802f',
    'evidence=caller-supplied',
    'state=main',
    'mutatingAllowed=false',
    'same current',
    'caller-supplied role or thread alternative fail closed',
    'Production blocker intake',
    'known-issues/bug labels',
    'Search before creating',
    'dependency edge',
    'nonblocking bug remains parallel',
    'verified fix unblocks',
    'missing human decision does not falsely',
  ]) {
    expect(skill).toContain(phrase);
  }
  for (const phrase of [
    'project worktree context --format json',
    'state=main',
    'state=owned',
    'state=foreign',
    'state=unmanaged',
    'fail-closed',
    'Every implementation mutation requires a GitHub issue',
    'main Project Manager task remains in the shared main checkout',
    'project codex start --issue <number> --environment-id <id> --operation-id <id>',
    'only that implementer task owns',
    'returned worktree',
    'same current `CODEX_THREAD_ID`',
    'caller-supplied evidence',
  ]) {
    expect(agents).toContain(phrase);
  }
  for (const legacyPhrase of [
    'GitHub issues are recommended for larger work but are not required',
    'persistent main Codex task runs `project worktree check`',
    'Otherwise it runs `project worktree prepare',
    "Project-managed worktrees are owned by the main task's",
  ]) {
    expect(agents).not.toContain(legacyPhrase);
  }
});

test('TASKS template and validator preserve the three-worker and proof contract', async () => {
  const template = await readFile(`${root}plugins/project-space/skills/project-manager/templates/TASKS.md`, 'utf8');
  expect(validateTasksDocument(template)).toEqual([]);
  const activeRow = '| #001 | `<thread-id>` | `<Project>/<environment-id>` | `<branch>; <Project-managed path>` | `<operation-id>` | `gpt-5.6-luna/high` | `active` | `<explicit contract>` | `<sha>` | `<PR and CI>` | no Preview | `<pending>` |';
  const tooMany = template.replace(
    '| #000 | `<thread-id>` | `<Project>/<environment-id>` | `<branch>; <Project-managed path>` | `<operation-id>` | `gpt-5.6-luna/high` | `queued` | `<explicit contract>` | `<sha or pending>` | `<PR and CI>` | `<exact-head Preview/browser proof or recorded no Preview>` | `<pending>` |',
    activeRow,
  ) + `\n${activeRow.replace('#001', '#002')}\n${activeRow.replace('#001', '#003')}\n${activeRow.replace('#001', '#004')}`;
  expect(validateTasksDocument(tooMany).join('\n')).toContain('at most three active');

  const escalated = template.replace(
    '`gpt-5.6-luna/high`',
    '`gpt-5.6-orion/medium`',
  );
  expect(validateTasksDocument(escalated)).toEqual([]);
  expect(validateTasksDocument(escalated.replace('`gpt-5.6-orion/medium`', ''))).toContain(
    'each worker row must record a non-empty model/reasoning record',
  );
  expect(validateTasksDocument(escalated.replace('`gpt-5.6-orion/medium`', '`escalated`'))).toContain(
    'each worker row must record a non-empty model/reasoning record',
  );

  const malformedBlocker = template.replace(
    '| none | searched open issues and Production records; no blocker found | none | no edge; queue unchanged | n/a | n/a |',
    '| #901 | issue linked | delivery | before delivery | high | <recovery> |',
  );
  expect(validateTasksDocument(malformedBlocker)).toContain(
    'each reproduced production blocker must record concrete evidence, issue action, affected stage, queue edge, owner, and recovery',
  );
  expect(validateTasksDocument(template.replace('## Production blocker intake', '## Removed intake'))).toContain(
    'missing required heading: ## Production blocker intake',
  );
});

test('workflow documentation repeats the no-Preview alternative', async () => {
  const docs = await readFile(`${root}docs/project-manager.md`, 'utf8');
  expect(docs).toContain('no Preview-compatible surface exists');
  expect(docs).toContain('desktop and mobile sizes');
  expect(docs).toContain('Normal authentication checks, CI and Preview gates');
  expect(docs).toContain('project codex start --issue <n> --environment-id <id> --operation-id <id>');
  expect(docs).toContain('cea348d649e01bc3bedbcba6b08ee7ae4001802f');
  expect(docs).toContain('caller-supplied');
  expect(docs).toContain('Existing evidence is linked and');
  expect(docs).toContain('Nonblocking bugs remain parallel');
});
