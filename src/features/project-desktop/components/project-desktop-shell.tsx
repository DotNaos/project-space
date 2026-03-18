import { WorkflowExplorer } from './workflow-explorer';
import { SpacesDock } from './spaces-dock';
import { useProjectDesktop } from '../hooks/use-project-desktop';
import { Button } from '@/components/ui/button';

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
          <WorkflowExplorer project={desktop.project} />
          {desktop.projects.length > 0 ? (
            <SpacesDock
              projects={desktop.projects.map((project) => ({
                id: project.id,
                label: project.name
              }))}
              activeProjectId={desktop.project?.id ?? ''}
              onSelect={desktop.selectProject}
              onCreate={desktop.createProject}
            />
          ) : null}
        </aside>

        <main className="flex min-h-0 flex-col bg-app-panel">
          <div className="border-b border-slate-800 px-8 py-4">
            <p className="text-sm font-medium text-slate-100">
              {desktop.project?.name ?? 'No project selected'}
            </p>
          </div>

          <div className="flex min-h-0 flex-1 items-center justify-center px-8">
            <div className="w-full max-w-2xl">
              {desktop.project ? (
                <>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                    Project Path
                  </p>
                  <p className="mt-3 font-mono text-xl font-medium tracking-tight text-slate-50">
                    {desktop.selectedProjectPath}
                  </p>
                </>
              ) : (
                <div className="space-y-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                    No Projects
                  </p>
                  <p className="text-2xl font-semibold tracking-tight text-slate-50">
                    Select your first project folder.
                  </p>
                  <Button type="button" variant="outline" onClick={desktop.createProject}>
                    Select project
                  </Button>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
