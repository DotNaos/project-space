import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder, Search } from 'lucide-react';
import {
  ScrollShadow,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Surface,
  Text
} from '@heroui/react';
import type {
  ProjectGroupRecord,
  ProjectNavigationItem,
  ProjectSpaceRecord
} from '@/shared/electron-api';
import { cn } from '@/lib/utils';
import { useProjectSpacesPickerStore } from '../stores/use-project-spaces-picker-store';

interface ProjectSpacesPickerProps {
  groups: ProjectGroupRecord[];
  projects: ProjectSpaceRecord[];
  rootItems: ProjectNavigationItem[];
  selectedProjectId: string;
  onSelectProject(projectId: string, groupId?: string): void;
}

interface ProjectPickerSection {
  id: string;
  label: string;
  projectIds: string[];
}

interface PickerPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

function matchesQuery(value: string, query: string) {
  return value.toLowerCase().includes(query.trim().toLowerCase());
}

export function ProjectSpacesPicker({
  groups,
  projects,
  rootItems,
  selectedProjectId,
  onSelectProject
}: ProjectSpacesPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [pickerPosition, setPickerPosition] = useState<PickerPosition | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
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

  const visibleProjectIds = useMemo(() => {
    return [
      ...filteredStandaloneProjectIds,
      ...filteredGroupedSections.flatMap((section) => section.projectIds)
    ];
  }, [filteredGroupedSections, filteredStandaloneProjectIds]);

  function resetPicker() {
    setIsOpen(false);
    setPickerPosition(null);
    setActiveProjectId(null);
    setQuery('');
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
      setPickerPosition(null);
      return;
    }

    function updatePickerPosition() {
      const rect = pickerRef.current?.getBoundingClientRect();

      if (!rect) {
        return;
      }

      const viewportPadding = 16;
      const drawerGap = 12;
      const availableAbove = rect.top - viewportPadding - drawerGap;
      const availableBelow = window.innerHeight - rect.bottom - viewportPadding - drawerGap;
      const shouldPlaceAbove = availableAbove >= 240 || availableAbove >= availableBelow;
      const maxHeight = Math.max(
        220,
        Math.min(availableAbove, shouldPlaceAbove ? 440 : availableBelow)
      );
      const top = shouldPlaceAbove
        ? Math.max(viewportPadding, rect.top - maxHeight - drawerGap)
        : rect.bottom + drawerGap;

      setPickerPosition({
        left: Math.max(rect.left, viewportPadding),
        top,
        width: Math.min(rect.width, window.innerWidth - viewportPadding * 2),
        maxHeight
      });
    }

    updatePickerPosition();
    window.addEventListener('resize', updatePickerPosition);
    window.addEventListener('scroll', updatePickerPosition, true);

    return () => {
      window.removeEventListener('resize', updatePickerPosition);
      window.removeEventListener('scroll', updatePickerPosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;

      if (
        pickerRef.current?.contains(target) ||
        drawerRef.current?.contains(target)
      ) {
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

    setActiveProjectId(visibleProjectIds[0] ?? null);
  }, [isOpen, query, visibleProjectIds]);

  useEffect(() => {
    if (!activeProjectId) {
      return;
    }

    optionRefs.current[activeProjectId]?.scrollIntoView({
      block: 'nearest'
    });
  }, [activeProjectId]);

  function openPicker() {
    setIsOpen(true);
  }

  function moveActiveResult(direction: 1 | -1) {
    if (visibleProjectIds.length === 0) {
      return;
    }

    const currentIndex = activeProjectId
      ? visibleProjectIds.indexOf(activeProjectId)
      : -1;
    const baseIndex = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = Math.min(
      Math.max(baseIndex + direction, 0),
      visibleProjectIds.length - 1
    );

    setActiveProjectId(visibleProjectIds[nextIndex] ?? null);
  }

  function renderProjectRow(projectId: string) {
    const project = projectsById[projectId];
    if (!project) {
      return null;
    }

    const isActive = activeProjectId === project.id;
    const isSelected = selectedProjectId === project.id;

    return (
      <button
        key={project.id}
        ref={(node) => {
          optionRefs.current[project.id] = node;
        }}
        type="button"
        onMouseEnter={() => {
          setActiveProjectId(project.id);
        }}
        onClick={() => {
          selectProjectById(project.id);
        }}
        className={cn(
          'flex w-full flex-col items-start gap-1.5 rounded-[20px] px-4 py-3 text-left transition',
          isActive
            ? 'bg-zinc-800 text-zinc-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]'
            : 'bg-transparent text-zinc-200 hover:bg-zinc-900/70',
          isSelected && !isActive
            ? 'shadow-[inset_0_0_0_1px_rgba(161,161,170,0.24)]'
            : null
        )}
      >
        <div className="flex w-full items-center justify-between gap-3">
          <Text className="truncate text-sm font-semibold text-current">
            {project.name}
          </Text>
          {project.kind === 'workspace' ? (
            <Text className="shrink-0 text-[11px] font-medium text-zinc-500">
              Workspace
            </Text>
          ) : null}
        </div>
        <Text className="w-full truncate text-[12px] font-medium text-zinc-500">
          {project.rootPath}
        </Text>
      </button>
    );
  }

  return (
    <div ref={pickerRef} className="relative w-full">
      <SearchField
        aria-label="Search projects"
        value={query}
        onChange={(value) => {
          if (!isOpen) {
            setIsOpen(true);
          }

          setQuery(value);
        }}
        className="w-full"
      >
        <SearchFieldGroup
          className={cn(
            'h-12 rounded-[24px] border bg-zinc-950/90 px-1 shadow-[0_12px_30px_rgba(0,0,0,0.24)] transition',
            isOpen ? 'border-zinc-600/80 bg-zinc-950' : 'border-zinc-800/80'
          )}
          onClick={() => {
            openPicker();
            searchInputRef.current?.focus();
          }}
        >
          <SearchFieldSearchIcon className="text-zinc-500" />
          <SearchFieldInput
            ref={searchInputRef}
            placeholder="Search projects"
            className="text-sm font-medium text-zinc-100 placeholder:text-zinc-500"
            onFocus={() => {
              openPicker();
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveActiveResult(1);
              }

              if (event.key === 'ArrowUp') {
                event.preventDefault();
                moveActiveResult(-1);
              }

              if (event.key === 'Enter' && activeProjectId) {
                event.preventDefault();
                selectProjectById(activeProjectId);
              }
            }}
          />
          {query.trim() ? (
            <SearchFieldClearButton
              onPress={() => {
                setQuery('');
                setActiveProjectId(visibleProjectIds[0] ?? null);
                searchInputRef.current?.focus();
              }}
            />
          ) : (
            <Search className="mr-2 h-4 w-4 text-zinc-700" strokeWidth={2} />
          )}
        </SearchFieldGroup>
      </SearchField>

      {isOpen && pickerPosition
        ? createPortal(
        <div
          className="fixed z-[120]"
          style={{
            left: `${pickerPosition.left}px`,
            top: `${pickerPosition.top}px`,
            width: `${pickerPosition.width}px`
          }}
        >
          <Surface
            ref={drawerRef}
            variant="secondary"
            className="flex min-h-0 flex-col overflow-hidden rounded-[30px] border border-zinc-800/90 bg-zinc-950/95 p-3 shadow-[0_26px_90px_rgba(0,0,0,0.58)] backdrop-blur-xl"
            style={{
              maxHeight: `${pickerPosition.maxHeight}px`
            }}
          >
            <div className="mb-3 flex justify-center">
              <div className="h-1 w-10 rounded-full bg-zinc-700/70" />
            </div>

            <ScrollShadow className="min-h-0 flex-1" hideScrollBar>
              {filteredStandaloneProjectIds.length > 0 || filteredGroupedSections.length > 0 ? (
                <div className="space-y-4 pb-1">
                  {filteredStandaloneProjectIds.length > 0 ? (
                    <div className="space-y-2">
                      <Text className="px-3 text-xs font-semibold text-zinc-500">
                        Projects
                      </Text>

                      <div className="space-y-1">
                        {filteredStandaloneProjectIds.map(renderProjectRow)}
                      </div>
                    </div>
                  ) : null}

                  {filteredGroupedSections.length > 0 ? (
                    <div className="space-y-4">
                      {filteredGroupedSections.map((section) => (
                        <div key={section.id} className="space-y-2">
                          <div className="flex items-center gap-2 px-3">
                            <Folder className="h-4 w-4 shrink-0 text-zinc-500" strokeWidth={1.8} />
                            <Text className="truncate text-xs font-semibold text-zinc-500">
                              {section.label}
                            </Text>
                          </div>
                          <div className="space-y-1">
                            {section.projectIds.map(renderProjectRow)}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-3">
                  <Text className="text-sm font-medium text-zinc-500">
                    No matching projects.
                  </Text>
                </div>
              )}
            </ScrollShadow>
          </Surface>
        </div>,
        document.body
      )
        : null}
    </div>
  );
}
