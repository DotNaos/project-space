import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';

const page = readFileSync(
  'src/features/codex-sessions/project-codex-chat-page.tsx',
  'utf8'
);
const mainPanel = readFileSync(
  'src/features/project-desktop/components/project-main-panel.tsx',
  'utf8'
);
const conversationPane = readFileSync(
  'src/features/codex-sessions/codex-conversation-pane.tsx',
  'utf8'
);
const createDialog = readFileSync(
  'src/features/codex-sessions/codex-thread-create-dialog.tsx',
  'utf8'
);
const taskDetail = readFileSync('src/features/project-tasks/project-task-detail.tsx', 'utf8');
const taskExperience = readFileSync('src/features/project-tasks/project-tasks-experience.tsx', 'utf8');
const webServer = readFileSync('server/web-server.ts', 'utf8');
const viteConfig = readFileSync('vite.config.ts', 'utf8');

describe('Project Codex chat page contract', () => {
  test('replaces the Project Chat surface with the real Codex conversation surface', () => {
    expect(mainPanel).toContain('ProjectCodexChatPage');
    expect(mainPanel).not.toContain('ProjectChatWorkspace');
    expect(page).toContain('<CodexTaskWorkspace');
    expect(page).toContain('<Chat');
    expect(page).toContain('disabled');
  });

  test('refreshes Tailscale before loading only the online host ids', () => {
    expect(page.indexOf('getTailscaleInventory(true)'))
      .toBeLessThan(page.indexOf('getCodexHostInventory()'));
    expect(page).toContain('hosts.map((host) => host.machineId)');
    expect(page).toContain('controller.loadMachines(machineIds)');
    expect(page).toContain('setHosts([])');
    expect(page).toContain('machineIds.includes(state.selectedOrigin.machineId)');
    expect(page).not.toContain('codexMachineIds');
  });

  test('keeps the task list on the right and removes redundant project selectors', () => {
    expect(page).not.toContain('<MachineSelect');
    expect(page).not.toContain('<WorktreeSelect');
    expect(page).toContain('<Drawer.Backdrop');
    expect(page).toContain('placement="right"');
    expect(page).toContain('lg:hidden');
    expect(page).toContain('hidden h-full min-h-0 w-[17rem] shrink-0 lg:block');
    expect(page).toContain('threads={[]}');
    expect(page).toContain('threadSections={sections}');
    expect(page).not.toContain('threads={sections.flatMap');
    expect(page.indexOf('flex min-h-0 min-w-0 flex-1 flex-col'))
      .toBeLessThan(page.indexOf('hidden h-full min-h-0 w-[17rem] shrink-0 lg:block'));
  });

  test('keeps the local app-server transport development-only', () => {
    expect(webServer).toContain("process.env.PROJECT_DEPLOY_ENVIRONMENT === 'prod'");
    expect(webServer).toContain('PROJECT_SPACE_LOCAL_CODEX_MACHINE_ID is disabled in production.');
    expect(webServer).toContain('connectorMachineId: localCodexMachineId');
  });

  test('uses one React runtime when the UI development package is linked', () => {
    expect(viteConfig).toContain("dedupe: ['react', 'react-dom']");
  });

  test('loads the published UI syntax runtime before its legacy Prism languages', () => {
    const uiPackage = JSON.parse(
      readFileSync('node_modules/@dotnaos/ui/package.json', 'utf8')
    ) as { version: string };
    const syntaxChunk = readdirSync('node_modules/@dotnaos/ui/dist/chunks')
      .find((file) => file.startsWith('prism-languages-') && file.endsWith('.js'));

    expect(uiPackage.version).toBe('0.0.13');
    expect(syntaxChunk).toBeDefined();

    const syntaxRuntime = readFileSync(
      `node_modules/@dotnaos/ui/dist/chunks/${syntaxChunk}`,
      'utf8'
    );
    const runtimeIndex = syntaxRuntime.indexOf('Reflect.set(globalThis, "Prism", Prism)');
    const languageIndex = syntaxRuntime.indexOf('await import("./prism-markup-');

    expect(runtimeIndex).toBeGreaterThanOrEqual(0);
    expect(languageIndex).toBeGreaterThan(runtimeIndex);
  });

  test('uses the shared Markdown message and supports pasted images', () => {
    expect(conversationPane).toContain('<ChatMessage');
    expect(conversationPane).not.toContain('<p className="break-words whitespace-pre-wrap">');
    expect(conversationPane).toContain('onPaste={(event) =>');
    expect(conversationPane).toContain('pastedCodexImages(event)');
    expect(conversationPane).toContain('imageAttachmentIds');
  });

  test('uses the shell surface without darker chat gutters', () => {
    expect(page).toContain('bg-app-panel');
    expect(page).not.toContain('bg-neutral-950 text-neutral-100');
    expect(mainPanel).toContain("projectTab === 'chat' && 'px-0 pt-0 sm:px-0 sm:pt-0'");
  });

  test('uses host-scoped worktrees in chat and binds issue detail to its own worktree', () => {
    expect(page).toContain("label: 'New task'");
    expect(page).toContain('<CodexThreadCreateDialog');
    expect(taskDetail).toContain('New Codex task');
    expect(createDialog).toContain('<Label>Machine</Label>');
    expect(createDialog).toContain('<Label>Worktree</Label>');
    expect(createDialog).toContain('taskBinding ?');
    expect(createDialog).toContain('This task always uses its own assigned worktree.');
    expect(createDialog).toContain('controller.start(machineId, selectedWorktree.path)');
    expect(createDialog).not.toContain('loadProjectWorktrees');
    expect(taskExperience).toContain('branch: selectedTask.branch?.name');
    expect(taskExperience).toContain('issueNumber: selectedTask.issue.number');
    expect(taskExperience).toContain('repository: repository.fullName');
  });
});
