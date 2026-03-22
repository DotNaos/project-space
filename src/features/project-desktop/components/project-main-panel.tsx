import { Button } from '@/components/ui/button';
import type { ExplorerTarget, LauncherAppRecord, ProjectSpaceRecord } from '@/shared/electron-api';
import { OpenTargetDropdown } from './open-target-dropdown';

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

  return (
    <main className="flex min-h-0 flex-col bg-app-panel">
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
          <p className="truncate text-[15px] font-semibold text-slate-100">
            {project?.name ?? 'No project selected'}
          </p>
          {project ? (
            <p className="shrink-0 pt-px text-[11px] uppercase tracking-[0.18em] text-slate-500">
              {selectedTargetName}
            </p>
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

      <div className="flex min-h-0 flex-1 items-center justify-center px-8">
        <div className="w-full max-w-2xl">
          {project ? (
            <>
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                {selectedExplorerTarget.kind === 'worktree' ? 'Worktree Path' : 'Workspace Path'}
              </p>
              <p className="mt-3 font-mono text-xl font-medium tracking-tight text-slate-50">
                {selectedTargetPath}
              </p>
              {launcherError ? (
                <p className="mt-4 text-sm text-amber-300">{launcherError}</p>
              ) : null}
            </>
          ) : (
            <div className="space-y-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                No Projects
              </p>
              <p className="text-2xl font-semibold tracking-tight text-slate-50">
                Add projects under {discoveryRoot || '~/projects'} to discover them.
              </p>
              <Button type="button" variant="outline" onClick={onCreateProject}>
                Select project
              </Button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
