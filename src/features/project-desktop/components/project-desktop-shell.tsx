import { Button } from '@/components/ui/button';
import { WorkflowExplorer } from './workflow-explorer';
import { SpacesDock } from './spaces-dock';
import { useProjectDesktop } from '../hooks/use-project-desktop';

export function ProjectDesktopShell() {
  const desktop = useProjectDesktop();

  return (
    <div className="h-screen overflow-hidden bg-app-canvas text-slate-100">
      <div className="grid h-full grid-cols-[294px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-slate-800 bg-app-sidebar">
          <div className="border-b border-slate-800 px-5 py-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
              project-space
            </p>
          </div>
          <WorkflowExplorer
            project={desktop.project}
            selection={desktop.selection}
            onSelect={desktop.selectNode}
          />
          <SpacesDock />
        </aside>

        <main className="flex min-h-0 flex-col bg-app-panel">
          <div className="border-b border-slate-800 px-8 py-4">
            <p className="text-sm font-medium text-slate-100">{desktop.project.name}</p>
          </div>

          <div className="flex min-h-0 flex-1 items-center justify-center px-8">
            <div className="w-full max-w-2xl">
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                Current Selection
              </p>
              <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-50">
                {desktop.selectedPath}
              </p>
            </div>
          </div>

          <div className="border-t border-slate-800 px-8 py-5">
            <div className="mx-auto flex max-w-2xl items-center justify-between gap-6 rounded-2xl border border-slate-800 bg-slate-950/70 px-5 py-4">
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                  Active
                </p>
                <p className="mt-2 truncate text-sm text-slate-300">{desktop.activeSelection}</p>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={desktop.confirmSelection}
                  disabled={!desktop.hasPendingSelection}
                >
                  {desktop.hasPendingSelection ? 'Select' : 'Selected'}
                </Button>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
