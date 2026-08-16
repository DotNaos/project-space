import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const page = readFileSync(
  'src/features/codex-sessions/project-codex-chat-page.tsx',
  'utf8'
);
const mainPanel = readFileSync(
  'src/features/project-desktop/components/project-main-panel.tsx',
  'utf8'
);
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
    expect(page).toContain('machineIds.includes(selectedMachineId)');
    expect(page).not.toContain('codexMachineIds');
  });

  test('keeps machine and worktree selection visible and moves the task list into a phone drawer', () => {
    expect(page).toContain('<MachineSelect');
    expect(page).toContain('<WorktreeSelect');
    expect(page).toContain('<Drawer.Backdrop');
    expect(page).toContain('lg:hidden');
    expect(page).toContain('hidden h-full min-h-0 w-[17rem] shrink-0 lg:block');
  });

  test('keeps the local app-server transport development-only', () => {
    expect(webServer).toContain("process.env.PROJECT_DEPLOY_ENVIRONMENT === 'prod'");
    expect(webServer).toContain('PROJECT_SPACE_LOCAL_CODEX_MACHINE_ID is disabled in production.');
  });

  test('uses one React runtime when the UI development package is linked', () => {
    expect(viteConfig).toContain("dedupe: ['react', 'react-dom']");
  });
});
