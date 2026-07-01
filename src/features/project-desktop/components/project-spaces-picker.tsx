import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Folder } from 'lucide-react';
import {
  Accordion,
  Chip,
  ScrollShadow,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Surface,
  Text
} from '@/app/dotnaos-ui';
import type { ReactNode } from 'react';
import type {
  ProjectGroupRecord,
  ProjectNavigationItem,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { useProjectSpacesPickerStore } from '../stores/use-project-spaces-picker-store';
import { ProjectTemplateStatusPill } from './project-template-check';
import { cn } from '@/lib/utils';

interface ProjectSpacesPickerProps {
  groups: ProjectGroupRecord[];
  projects: ProjectSpaceRecord[];
  rootItems: ProjectNavigationItem[];
  selectedProjectId: string;
  onSelectProject(projectId: string, groupId?: string): void;
  children: ReactNode;
}

interface ProjectPickerSection {
  id: string;
  label: string;
  projectIds: string[];
}

function matchesQuery(value: string, query: string) {
  return value.toLowerCase().includes(query.trim().toLowerCase());
}

function ProjectctlBadge({ project }: { project: ProjectSpaceRecord }) {
  if (!project.projectctl || project.projectctl.status === 'unmanaged') {
    return null;
  }

  return (
    <Chip size="sm" variant={project.projectctl.status === 'managed' ? 'primary' : 'secondary'}>
      {project.projectctl.status}
    </Chip>
  );
}

function projectMatchesQuery(project: ProjectSpaceRecord, query: string) {
  return matchesQuery(project.name, query) || matchesQuery(project.rootPath, query);
}

function ProjectPickerRow({
  project,
  selected,
  onSelect
}: {
  project: ProjectSpaceRecord;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      title={project.rootPath}
      onClick={onSelect}
      className={cn(
        'group grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2.5 text-left transition',
        selected
          ? 'bg-neutral-800/80 text-neutral-50 shadow-inner shadow-neutral-950/25'
          : 'text-neutral-300 hover:bg-neutral-900/70 hover:text-neutral-50'
      )}
    >
      <span className="grid min-w-0 gap-1">
        <span className="truncate text-sm font-semibold leading-5">
          {project.name}
        </span>
        <span className="truncate font-mono text-[11px] leading-4 text-neutral-500 group-hover:text-neutral-400">
          {project.rootPath}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {project.kind === 'workspace' ? (
          <span className="hidden text-[10px] uppercase tracking-[0.18em] text-neutral-500 sm:inline">
            WS
          </span>
        ) : null}
        <span className="hidden sm:inline-flex items-center gap-2">
          <ProjectctlBadge project={project} />
          <ProjectTemplateStatusPill check={project.fullstackTemplate} />
        </span>
        {selected ? (
          <span className="inline-flex size-6 items-center justify-center rounded-md bg-neutral-100 text-neutral-900">
            <Check className="size-3.5" strokeWidth={2} />
          </span>
        ) : null}
      </span>
    </button>
  );
}

export function ProjectSpacesPicker({
  groups,
  projects,
  rootItems,
  selectedProjectId,
  onSelectProject,
  children
}: ProjectSpacesPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const query = useProjectSpacesPickerStore((state) => state.query);
  const setQuery = useProjectSpacesPickerStore((state) => state.setQuery);

  const groupsById = useMemo(() => {
    return Object.fromEntries(groups.map((group) => [group.id, group]));
  }, [groups]);

  const projectsById = useMemo(() => {
    return Object.fromEntries(projects.map((project) => [project.id, project]));
  }, [projects]);

  const standaloneProjectIds = useMemo(() => {
    return rootItems
      .filter((item) => item.kind === 'project')
      .map((item) => item.projectId)
      .filter((projectId) => Boolean(projectsById[projectId]));
  }, [projectsById, rootItems]);

  const groupedSections = useMemo<ProjectPickerSection[]>(() => {
    return rootItems
      .filter((item) => item.kind === 'group')
      .map((item) => groupsById[item.groupId])
      .filter(Boolean)
      .map((group) => ({
        id: group.id,
        label: group.name,
        projectIds: group.childProjectIds.filter((projectId) => Boolean(projectsById[projectId]))
      }));
  }, [groupsById, projectsById, rootItems]);

  const filteredStandaloneProjectIds = useMemo(() => {
    if (!query.trim()) {
      return standaloneProjectIds;
    }

    return standaloneProjectIds.filter((projectId) => {
      const project = projectsById[projectId];
      return project ? projectMatchesQuery(project, query) : false;
    });
  }, [projectsById, query, standaloneProjectIds]);

  const filteredGroupedSections = useMemo(() => {
    if (!query.trim()) {
      return groupedSections;
    }

    return groupedSections
      .map((section) => {
        const groupMatches = matchesQuery(section.label, query);
        const projectIds = section.projectIds.filter((projectId) => {
          const project = projectsById[projectId];
          return project ? groupMatches || projectMatchesQuery(project, query) : false;
        });

        return projectIds.length > 0
          ? {
              ...section,
              projectIds
            }
          : null;
      })
      .filter((section): section is ProjectPickerSection => Boolean(section));
  }, [groupedSections, projectsById, query]);

  const effectiveExpandedGroupIds = useMemo(() => {
    if (query.trim()) {
      return new Set(filteredGroupedSections.map((section) => section.id));
    }

    return expandedGroupIds;
  }, [expandedGroupIds, filteredGroupedSections, query]);

  function resetPicker() {
    setIsOpen(false);
    setExpandedGroupIds(new Set());
  }

  function selectProjectById(projectId: string) {
    const project = projectsById[projectId];
    if (!project) {
      return;
    }

    onSelectProject(project.id, project.groupId);
    resetPicker();
  }

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (isWithinInteractiveArea(event.target)) {
        return;
      }

      resetPicker();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        resetPicker();
      }
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  function openPicker() {
    setIsOpen(true);
  }

  function isWithinInteractiveArea(target: EventTarget | null) {
    return (
      target instanceof Node &&
      (pickerRef.current?.contains(target) || contentRef.current?.contains(target))
    );
  }

  const pickerPopover =
    isOpen && typeof document !== 'undefined'
      ? createPortal(
          <div className="fixed left-1/2 top-16 z-[100] w-[min(680px,calc(100vw-2rem))] -translate-x-1/2">
            <Surface
              ref={contentRef}
              variant="transparent"
              className="flex max-h-[min(620px,calc(100vh-6rem))] min-h-0 flex-col rounded-xl border border-neutral-800 bg-neutral-950 p-3 shadow-2xl shadow-black/70"
              style={{ backgroundColor: '#020617' }}
            >
              <SearchField
                aria-label="Search projects"
                value={query}
                onChange={setQuery}
                className="w-full"
              >
                <SearchFieldGroup className="rounded-lg border border-neutral-800/80 bg-neutral-950/70">
                  <SearchFieldSearchIcon />
                  <SearchFieldInput
                    ref={searchInputRef}
                    autoFocus
                    placeholder="Search projects"
                    className="text-sm"
                  />
                  <SearchFieldClearButton />
                </SearchFieldGroup>
              </SearchField>

              <ScrollShadow className="mt-3 min-h-0 flex-1" hideScrollBar={false}>
                {filteredStandaloneProjectIds.length > 0 || filteredGroupedSections.length > 0 ? (
                  <div className="space-y-4 pb-1">
                    {filteredStandaloneProjectIds.length > 0 ? (
                      <div className="grid gap-1">
                        <Text className="px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-neutral-500">
                          Projects
                        </Text>

                        {filteredStandaloneProjectIds.map((projectId) => {
                          const project = projectsById[projectId];
                          if (!project) {
                            return null;
                          }

                          return (
                            <ProjectPickerRow
                              key={project.id}
                              project={project}
                              selected={selectedProjectId === project.id}
                              onSelect={() => {
                                selectProjectById(project.id);
                              }}
                            />
                          );
                        })}
                      </div>
                    ) : null}

                    {filteredGroupedSections.length > 0 ? (
                      <Accordion
                        allowsMultipleExpanded
                        expandedKeys={effectiveExpandedGroupIds}
                        onExpandedChange={(keys) => {
                          if (query.trim()) {
                            return;
                          }

                          setExpandedGroupIds(new Set(Array.from(keys, (key) => String(key))));
                        }}
                      >
                        {filteredGroupedSections.map((section) => (
                          <Accordion.Item key={section.id} id={section.id}>
                            <Accordion.Heading>
                              <Accordion.Trigger className="rounded-2xl px-3 py-3 text-left text-sm font-medium text-neutral-200 transition hover:bg-neutral-900/40 data-[expanded=true]:bg-neutral-900/25">
                                <span className="flex min-w-0 items-center gap-2">
                                  <Folder className="h-4 w-4 shrink-0 text-neutral-500" strokeWidth={1.8} />
                                  <span className="truncate">{section.label}</span>
                                </span>
                                <Accordion.Indicator className="text-neutral-500" />
                              </Accordion.Trigger>
                            </Accordion.Heading>
                            <Accordion.Panel>
                              <Accordion.Body className="ml-3 grid gap-1 border-l border-neutral-800/60 px-0 pt-1 pb-0 pl-2">
                                {section.projectIds.map((projectId) => {
                                  const project = projectsById[projectId];
                                  if (!project) {
                                    return null;
                                  }

                                  return (
                                    <ProjectPickerRow
                                      key={project.id}
                                      project={project}
                                      selected={selectedProjectId === project.id}
                                      onSelect={() => {
                                        selectProjectById(project.id);
                                      }}
                                    />
                                  );
                                })}
                              </Accordion.Body>
                            </Accordion.Panel>
                          </Accordion.Item>
                        ))}
                      </Accordion>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center px-3 py-3">
                    <Text className="text-sm text-neutral-500">
                      No matching projects.
                    </Text>
                  </div>
                )}
              </ScrollShadow>
            </Surface>
          </div>,
          document.body
        )
      : null;

  return (
    <div
      ref={pickerRef}
      className="relative flex w-full items-center"
      onClickCapture={() => {
        openPicker();
      }}
    >
      <div className="flex w-full items-center">{children}</div>

      {pickerPopover}
    </div>
  );
}
