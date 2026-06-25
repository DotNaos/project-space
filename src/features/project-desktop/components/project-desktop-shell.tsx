import { Button, Card } from '@heroui/react';
import { useProjectDesktop } from '../hooks/use-project-desktop';
import { SpacesDock } from './spaces-dock';
import { WorkflowExplorer } from './workflow-explorer';

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
                        <p className="text-sm font-medium text-slate-100">
                            {desktop.project.name}
                        </p>
                    </div>

                    <div className="flex min-h-0 flex-1 items-center justify-center px-8">
                        <Card
                            variant="secondary"
                            className="w-full max-w-2xl border border-slate-800/70 bg-slate-950/55 shadow-none">
                            <Card.Header className="px-6 pt-6">
                                <Card.Description className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                                    Current Selection
                                </Card.Description>
                                <Card.Title className="mt-3 text-2xl font-semibold tracking-tight text-slate-50">
                                    {desktop.selectedPath}
                                </Card.Title>
                            </Card.Header>
                        </Card>
                    </div>

                    <div className="border-t border-slate-800 px-8 py-5">
                        <Card
                            variant="secondary"
                            className="mx-auto max-w-2xl border border-slate-800/70 bg-slate-950/70 shadow-none">
                            <Card.Content className="flex items-center justify-between gap-6 px-5 py-4">
                                <div className="min-w-0">
                                    <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                                        Active
                                    </p>
                                    <p className="mt-2 truncate text-sm text-slate-300">
                                        {desktop.activeSelection}
                                    </p>
                                </div>
                                <div className="flex items-center gap-3">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onPress={desktop.confirmSelection}
                                        isDisabled={!desktop.hasPendingSelection}>
                                        {desktop.hasPendingSelection
                                            ? 'Select'
                                            : 'Selected'}
                                    </Button>
                                </div>
                            </Card.Content>
                        </Card>
                    </div>
                </main>
            </div>
        </div>
    );
}
