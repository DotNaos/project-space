import type {
  ExplorerTarget,
  LauncherAppRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { Button, Card, Chip, Surface, Text } from '@heroui/react';
import { OpenTargetDropdown } from './open-target-dropdown';
import { ProjectOperationsPanel } from './project-operations-panel';
import { ProjectWorkspaceTools } from './project-workspace-tools';

interface ProjectMainPanelProps {
  discoveryRoot: string;
  isSidebarOpen: boolean;
  launcherApps: LauncherAppRecord[];
  launcherError: string;
  selectedApp?: LauncherAppRecord;
  selectedAppLabel?: string;
  selectedExplorerTarget: ExplorerTarget;
  selectedTargetName: string;
  selectedTargetPath: string;
  sidebarClosedPaddingLeft: number;
  project?: ProjectSpaceRecord;
  onCreateProject(): void;
  onOpenSelectedTarget(): void;
  onSelectLauncherApp(appId: string): void;
}

export function ProjectMainPanel({
  discoveryRoot,
  isSidebarOpen,
  launcherApps,
  launcherError,
  selectedApp,
  selectedAppLabel,
  selectedExplorerTarget,
  selectedTargetName,
  selectedTargetPath,
  sidebarClosedPaddingLeft,
  project,
  onCreateProject,
  onOpenSelectedTarget,
  onSelectLauncherApp
}: ProjectMainPanelProps) {
  const headerSafeInset = isSidebarOpen ? 0 : sidebarClosedPaddingLeft;
  const targetLabel =
    selectedExplorerTarget.kind === 'worktree' ? 'Worktree Path' : 'Workspace Path';

  return (
    <Surface
      variant="transparent"
      className="flex min-h-0 flex-col rounded-none bg-app-panel"
    >
      <div
        className="relative flex h-14 items-center justify-between pr-6"
        style={{
          paddingLeft: isSidebarOpen ? '2rem' : `${sidebarClosedPaddingLeft}px`
        }}
      >
        <div
          className="app-drag absolute inset-y-0 right-0"
          style={{
            left: `${headerSafeInset}px`
          }}
        />

        <div className="relative flex min-w-0 items-center gap-3 leading-none">
          <Text className="truncate text-[15px] font-semibold text-slate-100">
            {project?.name ?? 'No project selected'}
          </Text>
          {project ? (
            <Chip
              color="default"
              size="sm"
              variant="tertiary"
              className="shrink-0 uppercase tracking-[0.18em] text-slate-400"
            >
              {selectedTargetName}
            </Chip>
          ) : null}
        </div>

        <div className="app-no-drag relative">
          <OpenTargetDropdown
            apps={launcherApps}
            disabled={!project || !selectedTargetPath}
            onOpen={onOpenSelectedTarget}
            onSelectApp={onSelectLauncherApp}
            selectedApp={selectedApp}
            selectedAppLabel={selectedAppLabel}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 px-8 pb-8 pt-4">
        {project ? (
          <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4">
            <Card
              variant="secondary"
              className="shrink-0 border border-slate-800/80 bg-slate-950/70"
            >
              <Card.Header className="gap-3">
                <Text className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                  {targetLabel}
                </Text>
                <Card.Title className="break-all font-mono text-lg font-medium tracking-tight text-slate-50">
                  {selectedTargetPath}
                </Card.Title>
              </Card.Header>
              <Card.Content className="gap-3">
                <Card.Description className="text-sm text-slate-400">
                  Run local commands, inspect git changes, and open Codex for this target.
                </Card.Description>
                {launcherError ? (
                  <Surface
                    variant="tertiary"
                    className="rounded-lg border border-amber-400/20 bg-amber-500/8 px-4 py-3 text-sm text-amber-300"
                  >
                    {launcherError}
                  </Surface>
                ) : null}
              </Card.Content>
            </Card>
            <ProjectOperationsPanel projectName={project.name} targetPath={selectedTargetPath} />
            <ProjectWorkspaceTools targetPath={selectedTargetPath} />
          </div>
        ) : (
          <div className="mx-auto flex h-full w-full max-w-6xl flex-col justify-center gap-4">
            <Card
              variant="secondary"
              className="w-full border border-slate-800/80 bg-slate-950/70"
            >
              <Card.Header className="gap-3">
                <Text className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                  No Projects
                </Text>
                <Card.Title className="text-2xl font-semibold tracking-tight text-slate-50">
                  Nothing selected yet
                </Card.Title>
                <Card.Description className="text-base text-slate-400">
                  Add projects under {discoveryRoot || '~/projects'} to discover them.
                </Card.Description>
              </Card.Header>
              <Card.Footer>
                <Button variant="outline" onPress={onCreateProject}>
                  Select project
                </Button>
              </Card.Footer>
            </Card>
            <ProjectOperationsPanel projectName="project-space" targetPath="" />
          </div>
        )}
      </div>
    </Surface>
  );
}
