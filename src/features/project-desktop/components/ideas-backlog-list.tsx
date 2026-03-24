import { useEffect, useMemo, useState } from 'react';

import {
  Button,
  ScrollShadow,
  Surface,
  Switch,
  Text
} from '@heroui/react';
import { ChevronDown, PenSquare, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { IdeaPresentationRecord } from '../lib/idea-utils';

interface IdeasBacklogListProps {
  ideas: IdeaPresentationRecord[];
  isLoading: boolean;
  onCreateIdea(): void;
  onSelectIdea(ideaId: string): void;
  selectedIdeaId: string;
  showClosedIssues: boolean;
  syncErrors: Record<string, string>;
  onToggleClosedIssues(nextValue: boolean): void;
}

type IdeaSectionId = 'drafts' | 'ready' | 'closed';

function formatTitle(idea: IdeaPresentationRecord) {
  return idea.title.trim() || 'Untitled idea';
}

function formatSummary(idea: IdeaPresentationRecord) {
  const firstBodyLine = idea.body
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  if (firstBodyLine) {
    return firstBodyLine;
  }

  if (idea.iteration.trim()) {
    return idea.iteration.trim();
  }

  return idea.source === 'github' ? 'Published idea' : 'Empty draft';
}

function getIdeaSectionId(idea: IdeaPresentationRecord): IdeaSectionId {
  if (idea.githubState === 'closed') {
    return 'closed';
  }

  if (idea.qualityGate.isReady) {
    return 'ready';
  }

  return 'drafts';
}

function getSectionTitle(sectionId: IdeaSectionId) {
  if (sectionId === 'ready') {
    return 'Ready';
  }

  if (sectionId === 'closed') {
    return 'Closed';
  }

  return 'Drafts';
}

export function IdeasBacklogList({
  ideas,
  isLoading,
  onCreateIdea,
  onSelectIdea,
  selectedIdeaId,
  showClosedIssues,
  syncErrors,
  onToggleClosedIssues
}: IdeasBacklogListProps) {
  const sections = useMemo(() => {
    const grouped: Record<IdeaSectionId, IdeaPresentationRecord[]> = {
      closed: [],
      drafts: [],
      ready: []
    };

    for (const idea of ideas) {
      grouped[getIdeaSectionId(idea)].push(idea);
    }

    return [
      { id: 'drafts' as const, ideas: grouped.drafts },
      { id: 'ready' as const, ideas: grouped.ready },
      { id: 'closed' as const, ideas: grouped.closed }
    ].filter((section) => section.ideas.length > 0);
  }, [ideas]);
  const [collapsedSections, setCollapsedSections] = useState<Record<IdeaSectionId, boolean>>({
    closed: !showClosedIssues,
    drafts: false,
    ready: false
  });

  useEffect(() => {
    setCollapsedSections((current) => ({
      ...current,
      closed: !showClosedIssues ? true : current.closed
    }));
  }, [showClosedIssues]);

  useEffect(() => {
    if (!selectedIdeaId) {
      return;
    }

    const selectedIdea = ideas.find((idea) => idea.id === selectedIdeaId);

    if (!selectedIdea) {
      return;
    }

    const selectedSectionId = getIdeaSectionId(selectedIdea);

    setCollapsedSections((current) => ({
      ...current,
      [selectedSectionId]: false
    }));
  }, [ideas, selectedIdeaId]);

  return (
    <Surface
      variant="secondary"
      className="flex h-full min-h-0 w-full flex-col rounded-[2rem] border border-zinc-800/70 bg-zinc-950/38 shadow-[0_24px_80px_rgba(0,0,0,0.28)]"
    >
      <div className="border-b border-zinc-800/80 px-6 py-5">
        <div className="flex items-center justify-between gap-3">
          <Text className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">
            Ideas
          </Text>

          <Button
            variant="primary"
            onPress={onCreateIdea}
            className="h-10 min-w-0 rounded-2xl bg-zinc-100 px-3 text-zinc-950 hover:bg-zinc-200"
          >
            <PenSquare className="h-4 w-4" strokeWidth={1.9} />
            <span>New idea</span>
          </Button>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 px-1 py-1">
          <div className="min-w-0">
            <Text className="text-xs uppercase tracking-[0.18em] text-zinc-500">Show closed</Text>
          </div>

          <Switch
            isSelected={showClosedIssues}
            onChange={(nextValue) => {
              onToggleClosedIssues(nextValue);
            }}
          />
        </div>
      </div>

      <ScrollShadow className="min-h-0 flex-1 px-5 py-4" hideScrollBar>
        {isLoading ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-400">
            <RefreshCw className="h-4 w-4 animate-spin" strokeWidth={1.8} />
            <span>Loading ideas…</span>
          </div>
        ) : ideas.length > 0 ? (
          <div aria-label="Ideas backlog" className="space-y-4">
            {sections.map((section) => {
              const isCollapsed = collapsedSections[section.id];

              return (
                <div key={section.id} className="space-y-2">
                  <Button
                    variant="ghost"
                    onPress={() => {
                      setCollapsedSections((current) => ({
                        ...current,
                        [section.id]: !current[section.id]
                      }));
                    }}
                    className="h-auto w-full justify-between rounded-2xl px-3 py-2.5 text-left text-zinc-400 hover:bg-zinc-900/25 hover:text-zinc-200"
                  >
                    <span className="text-[11px] uppercase tracking-[0.2em]">
                      {getSectionTitle(section.id)}
                    </span>
                    <span className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-600">
                      <span>{section.ideas.length}</span>
                      <ChevronDown
                        className={cn('h-3.5 w-3.5 transition-transform', isCollapsed ? '-rotate-90' : 'rotate-0')}
                        strokeWidth={1.9}
                      />
                    </span>
                  </Button>

                  {!isCollapsed ? (
                    <div className="space-y-2">
                      {section.ideas.map((idea) => {
                        const syncError = syncErrors[idea.id];
                        const title = formatTitle(idea);
                        const summary = formatSummary(idea);

                        return (
                          <Button
                            key={idea.id}
                            variant="ghost"
                            onClick={() => {
                              onSelectIdea(idea.id);
                            }}
                            onPress={() => {
                              onSelectIdea(idea.id);
                            }}
                            className={cn(
                              'h-auto w-full justify-start overflow-hidden rounded-2xl border px-0 py-0 text-left transition',
                              selectedIdeaId === idea.id
                                ? 'border-zinc-800/95 bg-zinc-900/80 text-zinc-50 shadow-[0_10px_30px_rgba(15,23,38,0.2)]'
                                : 'border-transparent bg-transparent text-zinc-300 hover:border-zinc-800/70 hover:bg-zinc-900/35'
                            )}
                          >
                            <div className="w-full min-w-0 space-y-2 overflow-hidden px-4 py-3.5">
                              <div className="flex min-w-0 items-start gap-3">
                                <span
                                  className={cn(
                                    'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                                    syncError
                                      ? 'bg-zinc-400'
                                      : idea.qualityGate.isReady
                                        ? 'bg-zinc-400'
                                        : 'bg-zinc-600'
                                  )}
                                />

                                <div className="min-w-0 flex-1 overflow-hidden">
                                  <span className="block truncate text-sm font-semibold text-current">
                                    {title}
                                  </span>
                                  <span className="mt-1 block truncate text-xs leading-5 text-zinc-500">
                                    {summary}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </Button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-3 py-4">
            <Text className="text-sm text-zinc-500">
              No ideas yet. Start with a rough local draft and give it a title when you are ready
              to push it to GitHub.
            </Text>
          </div>
        )}
      </ScrollShadow>
    </Surface>
  );
}
