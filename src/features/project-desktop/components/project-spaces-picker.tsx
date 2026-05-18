import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder } from 'lucide-react';
import {
  Accordion,
  Button,
  Chip,
  ScrollShadow,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Surface,
  Text
} from '@heroui/react';
import { Tooltip } from '@heroui/react';
import type { ReactNode } from 'react';
import type {
  ProjectGroupRecord,
  ProjectNavigationItem,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { useProjectSpacesPickerStore } from '../stores/use-project-spaces-picker-store';

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
  const closeTimeoutRef = useRef<number | null>(null);
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
      return project ? matchesQuery(project.name, query) : false;
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
          return project ? groupMatches || matchesQuery(project.name, query) : false;
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

  function cancelClose() {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }

  function resetPicker() {
    cancelClose();
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
    return () => {
      cancelClose();
    };
  }, []);

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
      if (pickerRef.current?.contains(event.target as Node)) {
        cancelClose();
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
    cancelClose();
    setIsOpen(true);
  }

  function scheduleClose() {
    cancelClose();
    closeTimeoutRef.current = window.setTimeout(() => {
      resetPicker();
    }, 160);
  }

  function isWithinInteractiveArea(target: EventTarget | null) {
    return (
      target instanceof Node &&
      (pickerRef.current?.contains(target) || contentRef.current?.contains(target))
    );
  }

  function handlePointerEnter() {
    openPicker();
  }

  function handlePointerLeave(event: React.PointerEvent<HTMLElement>) {
    if (isWithinInteractiveArea(event.relatedTarget)) {
      cancelClose();
      return;
    }

    scheduleClose();
  }

  return (
    <div
      ref={pickerRef}
      className="relative flex w-full items-center"
      onFocusCapture={handlePointerEnter}
      onBlurCapture={(event) => {
        if (isWithinInteractiveArea(event.relatedTarget)) {
          cancelClose();
          return;
        }

        scheduleClose();
      }}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <div className="flex w-full items-center">{children}</div>

      {isOpen ? (
        <div className="absolute bottom-full left-1/2 z-50 mb-3 w-[340px] -translate-x-1/2">
          <Surface
            ref={contentRef}
            variant="secondary"
            className="flex h-[420px] min-h-0 flex-col rounded-3xl border border-slate-800/80 p-3 shadow-2xl shadow-slate-950/40"
          >
            <SearchField
              aria-label="Search projects"
              value={query}
              onChange={setQuery}
              className="w-full"
            >
              <SearchFieldGroup className="rounded-2xl border border-slate-800/80 bg-slate-950/70">
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

            <ScrollShadow className="mt-3 min-h-0 flex-1" hideScrollBar>
              {filteredStandaloneProjectIds.length > 0 || filteredGroupedSections.length > 0 ? (
                <div className="space-y-3 pb-1">
                  {filteredStandaloneProjectIds.length > 0 ? (
                    <div className="space-y-1">
                      <Text className="px-3 py-1 text-xs font-medium text-slate-500">
                        Projects
                      </Text>

                      {filteredStandaloneProjectIds.map((projectId) => {
                        const project = projectsById[projectId];
                        if (!project) {
                          return null;
                        }

                        return (
                          <Tooltip key={project.id} delay={0}>
                            <Tooltip.Trigger className="block w-full">
                              <Button
                                fullWidth
                                variant={selectedProjectId === project.id ? 'secondary' : 'ghost'}
                                onPress={() => {
                                  selectProjectById(project.id);
                                }}
                                className="h-auto min-h-0 justify-start rounded-2xl px-3 py-3 text-left"
                              >
                                <div className="flex w-full items-center justify-between gap-3">
                                  <Text className="truncate text-sm font-medium text-slate-100">
                                    {project.name}
                                  </Text>
                                  {project.kind === 'workspace' ? (
                                    <Text className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                                      WS
                                    </Text>
                                  ) : null}
                                  <ProjectctlBadge project={project} />
                                </div>
                              </Button>
                            </Tooltip.Trigger>
                            <Tooltip.Content showArrow placement="right">
                              <Tooltip.Arrow />
                              {project.rootPath}
                            </Tooltip.Content>
                          </Tooltip>
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
                            <Accordion.Trigger className="rounded-2xl px-3 py-3 text-left text-sm font-medium text-slate-200 transition hover:bg-slate-900/40 data-[expanded=true]:bg-slate-900/25">
                              <span className="flex min-w-0 items-center gap-2">
                                <Folder className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={1.8} />
                                <span className="truncate">{section.label}</span>
                              </span>
                              <Accordion.Indicator className="text-slate-500" />
                            </Accordion.Trigger>
                          </Accordion.Heading>
                          <Accordion.Panel>
                            <Accordion.Body className="ml-3 space-y-1 border-l border-slate-800/60 px-0 pt-1 pb-0 pl-2">
                              {section.projectIds.map((projectId) => {
                                const project = projectsById[projectId];
                                if (!project) {
                                  return null;
                                }

                                return (
                                  <Tooltip key={project.id} delay={0}>
                                    <Tooltip.Trigger className="block w-full">
                                      <Button
                                        fullWidth
                                        variant={
                                          selectedProjectId === project.id ? 'secondary' : 'ghost'
                                        }
                                        onPress={() => {
                                          selectProjectById(project.id);
                                        }}
                                        className="h-auto min-h-0 justify-start rounded-2xl px-3 py-3 text-left"
                                      >
                                        <div className="flex w-full items-center justify-between gap-3">
                                          <Text className="truncate text-sm font-medium text-slate-100">
                                            {project.name}
                                          </Text>
                                          {project.kind === 'workspace' ? (
                                            <Text className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                                              WS
                                            </Text>
                                          ) : null}
                                          <ProjectctlBadge project={project} />
                                        </div>
                                      </Button>
                                    </Tooltip.Trigger>
                                    <Tooltip.Content showArrow placement="right">
                                      <Tooltip.Arrow />
                                      {project.rootPath}
                                    </Tooltip.Content>
                                  </Tooltip>
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
                  <Text className="text-sm text-slate-500">
                    No matching projects.
                  </Text>
                </div>
              )}
            </ScrollShadow>
          </Surface>
        </div>
      ) : null}
    </div>
  );
}
