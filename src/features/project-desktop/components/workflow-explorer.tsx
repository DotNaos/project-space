import { useEffect, useRef, useState } from 'react';
import { Button, Chip, ScrollShadow, Spinner, Text } from '@heroui/react';
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Lightbulb,
  ListTodo,
  Trash2
} from 'lucide-react';

import { cn } from '@/lib/utils';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import type { ProjectMainView } from './project-main-panel';
import type { IdeaPresentationRecord } from '../lib/idea-utils';

interface WorkflowExplorerProps {
  isInteractive?: boolean;
  isAppLoading?: boolean;
  isWorktreesLoading?: boolean;
  mainView: ProjectMainView;
  onCreateIdea(): void;
  onDeleteIdea(ideaId: string): void;
  onMoveIdeaToWorktree(ideaId: string, targetWorktreeId?: string): void;
  onOpenIdeasView(): void;
  onOpenNewWorktree(): void;
  onOpenWorktreeInApp(worktreeId: string): void;
  onOpenWorktreesView(): void;
  onSelectIdea(ideaId: string): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  project?: ProjectSpaceRecord;
  selectedIdeaId?: string;
  selectedExplorerTarget: ExplorerTarget;
  unassignedIdeas: IdeaPresentationRecord[];
  worktreeIdeasById: Record<string, IdeaPresentationRecord[]>;
  worktrees: ProjectWorktreeRecord[];
}

interface TargetRowProps {
  badge?: string;
  dropActive?: boolean;
  label: string;
  onOpenInApp?(): void;
  onPress(): void;
  selected: boolean;
  dropTargetId?: string;
}

function TargetRow({
  badge,
  dropActive,
  dropTargetId,
  label,
  onOpenInApp,
  onPress,
  selected
}: TargetRowProps) {
  return (
    <div
      data-worktree-drop-target={dropTargetId}
      className={cn(
        'group relative rounded-2xl transition',
        dropActive && 'ring-1 ring-zinc-500/70 ring-inset',
      )}
    >
      <Button
        variant="ghost"
        onPress={onPress}
        className={cn(
          'h-auto w-full min-w-0 justify-start rounded-2xl px-3 py-3 text-left transition',
          selected
            ? 'bg-zinc-800/65 text-zinc-50'
            : 'text-zinc-300 hover:bg-zinc-900/30 hover:text-zinc-50'
        )}
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="relative mt-0.5 ml-0.5 h-4 w-4 shrink-0">
            <FolderGit2
              className={cn(
                'absolute inset-0 h-4 w-4 transition-opacity duration-150',
                onOpenInApp && 'group-hover:opacity-0',
                selected ? 'text-zinc-100' : 'text-zinc-500'
              )}
              strokeWidth={1.9}
            />
            {onOpenInApp ? (
              <Button
                aria-label={`Open ${label} in the selected app`}
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={(event) => {
                  event.continuePropagation?.();
                  onOpenInApp();
                }}
                className="absolute inset-[-4px] z-10 flex h-6 w-6 min-w-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-zinc-500 opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-zinc-900/45 hover:text-zinc-50 data-[pressed=true]:scale-[0.98]"
              >
                <ArrowUpRight className="h-3 w-3" strokeWidth={1.9} />
              </Button>
            ) : null}
          </div>
          <div className="min-w-0 flex-1 basis-0 overflow-hidden">
            <Text className="truncate text-left text-[15px] font-medium text-current">
              {label}
            </Text>
          </div>
          <div className="flex shrink-0 items-center gap-2 pl-3">
            {badge ? (
              <Chip
                color="default"
                size="sm"
                variant="soft"
                className="rounded-full bg-zinc-900/85 px-2 text-[10px] uppercase tracking-[0.16em] text-zinc-100"
              >
                {badge}
              </Chip>
            ) : null}
          </div>
        </div>
      </Button>
    </div>
  );
}

function formatIdeaTitle(idea: IdeaPresentationRecord) {
  return idea.title.trim() || 'Untitled idea';
}

interface IdeaRowProps {
  icon: React.ReactNode;
  isDragging: boolean;
  isSelected: boolean;
  label: string;
  onDelete(): void;
  onMouseDown(event: React.MouseEvent<HTMLButtonElement>): void;
  onSelect(): void;
}

function IdeaRow({
  icon,
  isDragging,
  isSelected,
  label,
  onDelete,
  onMouseDown,
  onSelect
}: IdeaRowProps) {
  return (
    <div className="group relative rounded-xl">
      <button
        type="button"
        onClick={onSelect}
        onMouseDown={onMouseDown}
        data-dragging={isDragging ? 'true' : 'false'}
        className={cn(
          'idea-drag-handle flex h-auto w-full items-start justify-start rounded-xl px-3 py-2 text-left transition hover:bg-zinc-900/25 hover:text-zinc-200',
          isDragging && 'scale-[0.985] opacity-60',
          isSelected ? 'bg-zinc-900/55 text-zinc-100' : 'text-zinc-500'
        )}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="mt-0.5 h-3.5 w-3.5 shrink-0 transition-opacity duration-150 group-hover:opacity-0">
            {icon}
          </div>
          <Text className="truncate text-left text-[13px] text-current">{label}</Text>
        </div>
      </button>

      <button
        type="button"
        aria-label={`Delete ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        className="absolute top-[8px] left-[10px] z-10 flex h-5 w-5 items-center justify-center rounded-full bg-transparent text-zinc-600 opacity-0 transition-all duration-150 group-hover:opacity-100 hover:bg-zinc-900/55 hover:text-zinc-100"
      >
        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
      </button>
    </div>
  );
}

interface SidebarPanelProps {
  children?: React.ReactNode;
  header: React.ReactNode;
  isCollapsed: boolean;
  className?: string;
}

function SidebarPanel({ children, header, isCollapsed, className }: SidebarPanelProps) {
  return (
    <section className={cn('border-t border-zinc-900/80 pt-3', className)}>
      {header}
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity,margin] duration-200 ease-out',
          isCollapsed ? 'mt-0 grid-rows-[0fr] opacity-0' : 'mt-2 grid-rows-[1fr] opacity-100'
        )}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </section>
  );
}

export function WorkflowExplorer({
  isInteractive = true,
  isAppLoading = false,
  isWorktreesLoading = false,
  mainView,
  onCreateIdea,
  onDeleteIdea,
  onMoveIdeaToWorktree,
  onOpenIdeasView,
  onOpenNewWorktree,
  onOpenWorktreeInApp,
  onOpenWorktreesView,
  onSelectIdea,
  onSelectWorkspace,
  onSelectWorktree,
  project,
  selectedIdeaId,
  selectedExplorerTarget,
  unassignedIdeas,
  worktreeIdeasById,
  worktrees
}: WorkflowExplorerProps) {
  const [draggingIdeaId, setDraggingIdeaId] = useState('');
  const [dropTargetWorktreeId, setDropTargetWorktreeId] = useState('');
  const [ideasCollapsed, setIdeasCollapsed] = useState(false);
  const [worktreesCollapsed, setWorktreesCollapsed] = useState(false);
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);
  const pendingDragRef = useRef<{
    ideaId: string;
    label: string;
    startX: number;
    startY: number;
  } | null>(null);
  const suppressClickUntilRef = useRef(0);
  const getWorktreeLabel = (worktree: ProjectWorktreeRecord) =>
    worktree.branchName?.trim() || worktree.name;

  useEffect(() => {
    return () => {
      document.body.classList.remove('idea-dragging');
      dragPreviewRef.current?.remove();
      dragPreviewRef.current = null;
    };
  }, []);

  function cleanupDragState() {
    document.body.classList.remove('idea-dragging');
    setDraggingIdeaId('');
    setDropTargetWorktreeId('');
    pendingDragRef.current = null;
    dragPreviewRef.current?.remove();
    dragPreviewRef.current = null;
  }

  function createDragPreview(label: string) {
    dragPreviewRef.current?.remove();

    const preview = document.createElement('div');
    preview.textContent = label;
    preview.className =
      'pointer-events-none fixed left-0 top-0 z-[9999] max-w-[240px] overflow-hidden text-ellipsis whitespace-nowrap rounded-xl border border-zinc-700/80 bg-zinc-900/96 px-3 py-2 text-[13px] font-medium text-zinc-50 shadow-[0_16px_40px_rgba(0,0,0,0.35)]';
    preview.style.transform = 'translate(-9999px, -9999px)';
    document.body.appendChild(preview);
    dragPreviewRef.current = preview;
    return preview;
  }

  useEffect(() => {
    function updatePreviewPosition(clientX: number, clientY: number) {
      if (!dragPreviewRef.current) {
        return;
      }

      dragPreviewRef.current.style.transform = `translate(${clientX + 2}px, ${clientY + 2}px)`;
    }

    function updateDropTarget(clientX: number, clientY: number) {
      const hoveredElement = document.elementFromPoint(clientX, clientY);
      const targetElement = hoveredElement?.closest<HTMLElement>('[data-worktree-drop-target]');
      const nextTargetId = targetElement?.dataset.worktreeDropTarget ?? '';

      setDropTargetWorktreeId(nextTargetId);
    }

    function handleMouseMove(event: MouseEvent) {
      const pendingDrag = pendingDragRef.current;

      if (!pendingDrag) {
        return;
      }

      if (!draggingIdeaId) {
        const deltaX = event.clientX - pendingDrag.startX;
        const deltaY = event.clientY - pendingDrag.startY;
        const movement = Math.hypot(deltaX, deltaY);

        if (movement < 5) {
          return;
        }

        document.body.classList.add('idea-dragging');
        createDragPreview(pendingDrag.label);
        setDraggingIdeaId(pendingDrag.ideaId);
      }

      updatePreviewPosition(event.clientX, event.clientY);
      updateDropTarget(event.clientX, event.clientY);
    }

    function handleMouseUp() {
      const pendingDrag = pendingDragRef.current;

      if (!pendingDrag) {
        return;
      }

      const draggedIdeaId = pendingDrag.ideaId;
      const targetId = dropTargetWorktreeId || undefined;
      const didDrag = Boolean(draggingIdeaId);

      if (didDrag) {
        suppressClickUntilRef.current = Date.now() + 200;
        void onMoveIdeaToWorktree(draggedIdeaId, targetId === '__project__' ? undefined : targetId);
      }

      cleanupDragState();
    }

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingIdeaId, dropTargetWorktreeId, onMoveIdeaToWorktree]);

  const branchWorktrees = worktrees.filter((worktree) => !worktree.isBase);

  return (
    <ScrollShadow className="h-full min-h-0 px-4 py-5" hideScrollBar>
      {project ? (
        <div className="flex min-h-full flex-col justify-end">
          <div className="space-y-0">
            <SidebarPanel
            isCollapsed={ideasCollapsed}
            className="border-t-0 pt-0"
            header={
              <div
                data-worktree-drop-target="__project__"
                className={cn(
                  'group flex items-center gap-3 rounded-xl px-2 py-2 transition',
                  dropTargetWorktreeId === '__project__' && 'ring-1 ring-zinc-500/70 ring-inset'
                )}
              >
                <div className="relative h-4 w-4 shrink-0">
                  <Lightbulb
                    className="absolute inset-0 h-4 w-4 text-zinc-500 transition-opacity duration-150 group-hover:opacity-0"
                    strokeWidth={1.9}
                  />
                  <button
                    type="button"
                    aria-label={ideasCollapsed ? 'Expand ideas panel' : 'Collapse ideas panel'}
                    onClick={() => {
                      setIdeasCollapsed((current) => !current);
                    }}
                    className="absolute inset-0 flex items-center justify-center text-zinc-400 opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-zinc-100"
                  >
                    {ideasCollapsed ? (
                      <ChevronRight className="h-4 w-4" strokeWidth={1.9} />
                    ) : (
                      <ChevronDown className="h-4 w-4" strokeWidth={1.9} />
                    )}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    if (isInteractive) {
                      onOpenIdeasView();
                    }
                  }}
                  className={cn(
                    'min-w-0 flex-1 truncate text-left text-[15px] font-semibold transition',
                    selectedExplorerTarget.kind === 'workspace'
                      ? 'text-zinc-50'
                      : 'text-zinc-300 hover:text-zinc-50'
                  )}
                >
                  Ideas
                </button>

                <div className="relative ml-auto h-8 w-8 shrink-0">
                  <Chip
                    color="default"
                    size="sm"
                    variant="soft"
                    className="absolute inset-0 ml-auto flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900/85 px-0 text-[10px] uppercase tracking-[0.16em] text-zinc-100 transition-all duration-150 group-hover:scale-95 group-hover:opacity-0"
                  >
                    {unassignedIdeas.length}
                  </Chip>
                  <Button
                    aria-label="Create new idea"
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    onPress={() => {
                      onCreateIdea();
                    }}
                    className="absolute inset-0 z-10 h-8 w-8 min-w-0 rounded-full border-0 bg-transparent text-zinc-400 opacity-0 transition-all duration-180 group-hover:opacity-100 hover:bg-transparent hover:text-zinc-50 data-[pressed=true]:scale-[0.98]"
                  >
                    <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </Button>
                </div>
              </div>
            }
          >
            {unassignedIdeas.length > 0 ? (
              <div className="space-y-1">
                {unassignedIdeas.map((idea) => (
                  <IdeaRow
                    key={idea.id}
                    icon={
                      <Lightbulb
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          selectedIdeaId === idea.id ? 'text-zinc-300' : 'text-zinc-600'
                        )}
                        strokeWidth={1.8}
                      />
                    }
                    isDragging={draggingIdeaId === idea.id}
                    isSelected={selectedIdeaId === idea.id}
                    label={formatIdeaTitle(idea)}
                    onDelete={() => {
                      onDeleteIdea(idea.id);
                    }}
                    onMouseDown={(event) => {
                      if (event.button !== 0) {
                        return;
                      }

                      pendingDragRef.current = {
                        ideaId: idea.id,
                        label: formatIdeaTitle(idea),
                        startX: event.clientX,
                        startY: event.clientY
                      };
                    }}
                    onSelect={() => {
                      if (Date.now() < suppressClickUntilRef.current) {
                        return;
                      }
                      onSelectIdea(idea.id);
                    }}
                  />
                ))}
              </div>
            ) : (
              <Text className="px-3 py-3 text-sm text-zinc-600">
                No unassigned ideas yet.
              </Text>
            )}
            </SidebarPanel>

            <SidebarPanel
            isCollapsed={worktreesCollapsed}
            header={
              <div className="group flex items-center gap-3 rounded-xl px-2 py-2">
                <div className="relative h-4 w-4 shrink-0">
                  <GitBranch
                    className="absolute inset-0 h-4 w-4 text-zinc-500 transition-opacity duration-150 group-hover:opacity-0"
                    strokeWidth={1.9}
                  />
                  <button
                    type="button"
                    aria-label={worktreesCollapsed ? 'Expand worktrees panel' : 'Collapse worktrees panel'}
                    onClick={() => {
                      setWorktreesCollapsed((current) => !current);
                    }}
                    className="absolute inset-0 flex items-center justify-center text-zinc-400 opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-zinc-100"
                  >
                    {worktreesCollapsed ? (
                      <ChevronRight className="h-4 w-4" strokeWidth={1.9} />
                    ) : (
                      <ChevronDown className="h-4 w-4" strokeWidth={1.9} />
                    )}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    if (isInteractive) {
                      onOpenWorktreesView();
                    }
                  }}
                  className={cn(
                    'min-w-0 flex-1 truncate text-left text-[15px] font-semibold transition',
                    mainView === 'worktrees' ? 'text-zinc-50' : 'text-zinc-300 hover:text-zinc-50'
                  )}
                >
                  Worktrees
                </button>

                <Button
                  aria-label="Create new worktree"
                  isIconOnly
                  variant="ghost"
                  onPress={onOpenNewWorktree}
                  className="h-8 w-8 min-w-0 rounded-xl text-zinc-500 hover:bg-zinc-900/30 hover:text-zinc-100"
                >
                  <FolderPlus className="h-4 w-4" strokeWidth={1.9} />
                </Button>
              </div>
            }
          >
            {isWorktreesLoading && branchWorktrees.length === 0 ? (
              <div className="flex items-center gap-3 px-4 py-4 text-zinc-500">
                <Spinner aria-label="Loading worktrees" className="text-zinc-500" size="sm" />
                <Text className="text-sm text-zinc-500">Loading worktrees</Text>
              </div>
            ) : branchWorktrees.length > 0 ? (
              <div className="space-y-1">
                {branchWorktrees.map((worktree) => {
                  const isSelected =
                    selectedExplorerTarget.kind === 'worktree' &&
                    selectedExplorerTarget.worktreeId === worktree.id;
                  const worktreeIdeas = worktreeIdeasById[worktree.id] ?? [];

                  return (
                    <div key={worktree.id} className="space-y-1">
                      <TargetRow
                        badge={worktree.status === 'broken' ? 'broken' : undefined}
                        dropActive={dropTargetWorktreeId === worktree.id}
                        dropTargetId={worktree.id}
                        label={getWorktreeLabel(worktree)}
                        onOpenInApp={() => {
                          if (!isInteractive) {
                            return;
                          }

                          onOpenWorktreeInApp(worktree.id);
                        }}
                        onPress={() => {
                          onSelectWorktree(worktree.id);
                        }}
                        selected={isSelected}
                      />

                      {worktreeIdeas.length > 0 ? (
                        <div className="space-y-1 pl-8">
                          {worktreeIdeas.map((idea) => (
                            <IdeaRow
                              key={idea.id}
                              icon={
                                <ListTodo
                                  className={cn(
                                    'h-3.5 w-3.5 shrink-0',
                                    selectedIdeaId === idea.id ? 'text-zinc-300' : 'text-zinc-600'
                                  )}
                                  strokeWidth={1.8}
                                />
                              }
                              isDragging={draggingIdeaId === idea.id}
                              isSelected={selectedIdeaId === idea.id}
                              label={formatIdeaTitle(idea)}
                              onDelete={() => {
                                onDeleteIdea(idea.id);
                              }}
                              onMouseDown={(event) => {
                                if (event.button !== 0) {
                                  return;
                                }

                                pendingDragRef.current = {
                                  ideaId: idea.id,
                                  label: formatIdeaTitle(idea),
                                  startX: event.clientX,
                                  startY: event.clientY
                                };
                              }}
                              onSelect={() => {
                                if (Date.now() < suppressClickUntilRef.current) {
                                  return;
                                }
                                onSelectIdea(idea.id);
                              }}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <Text className="px-3 py-3 text-sm text-zinc-600">
                No worktrees yet.
              </Text>
            )}
            </SidebarPanel>
          </div>
        </div>
      ) : (
        isAppLoading ? (
          <div className="flex items-center gap-3 px-4 py-5 text-zinc-500">
            <Spinner aria-label="Loading projects" className="text-zinc-500" size="sm" />
            <Text className="text-sm text-zinc-500">Loading projects</Text>
          </div>
        ) : (
          <Text className="px-3 py-2 text-sm text-zinc-500">
            No projects yet. Create one with the + button below.
          </Text>
        )
      )}
    </ScrollShadow>
  );
}
