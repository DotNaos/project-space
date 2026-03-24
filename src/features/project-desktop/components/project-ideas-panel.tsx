import { Card, Surface, Text } from '@heroui/react';

import type { ProjectSpaceRecord, ProjectWorktreeRecord } from '@/shared/electron-api';

import { IdeasBacklogList } from './ideas-backlog-list';
import { IdeaEditor } from './idea-editor';
import type { EditableIdeaValues, IdeaPresentationRecord } from '../lib/idea-utils';

interface ProjectIdeasPanelProps {
  draftValues: EditableIdeaValues;
  ideaExportMessage: string;
  ideas: IdeaPresentationRecord[];
  isLoading: boolean;
  isIdeaExporting: boolean;
  isSaving: boolean;
  loadError: string;
  onCreateIdea(): void;
  onExportIdeaToWorktree(): void;
  onSaveIdea(): void;
  onSelectIdea(ideaId: string): void;
  onToggleClosedIssues(nextValue: boolean): void;
  onUpdateIdeaValue<Key extends keyof EditableIdeaValues>(
    key: Key,
    value: EditableIdeaValues[Key]
  ): void;
  project?: ProjectSpaceRecord;
  selectedIdea?: IdeaPresentationRecord;
  selectedIdeaId: string;
  selectedWorktree?: ProjectWorktreeRecord;
  showClosedIssues: boolean;
  sidebarClosedPaddingLeft: number;
  syncErrors: Record<string, string>;
  isDirty: boolean;
}

export function ProjectIdeasPanel({
  draftValues,
  ideaExportMessage,
  ideas,
  isDirty,
  isIdeaExporting,
  isLoading,
  isSaving,
  loadError,
  onCreateIdea,
  onExportIdeaToWorktree,
  onSaveIdea,
  onSelectIdea,
  onToggleClosedIssues,
  onUpdateIdeaValue,
  project,
  selectedIdea,
  selectedIdeaId,
  selectedWorktree,
  showClosedIssues,
  sidebarClosedPaddingLeft,
  syncErrors
}: ProjectIdeasPanelProps) {
  if (!project) {
    return (
      <Surface variant="transparent" className="flex min-h-0 flex-1 items-center justify-center bg-app-panel px-8">
        <Card variant="secondary" className="w-full max-w-xl border border-zinc-800/80 bg-zinc-950/70">
          <Card.Header className="gap-3">
            <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
              Ideas
            </Text>
            <Card.Title className="text-2xl font-semibold tracking-tight text-zinc-50">
              Select a project first
            </Card.Title>
            <Card.Description className="text-base text-zinc-400">
              Ideas are scoped to a project, so pick a project in the sidebar before opening the
              backlog.
            </Card.Description>
          </Card.Header>
        </Card>
      </Surface>
    );
  }

  const candidateIdeas = ideas.filter((idea) => idea.id !== selectedIdeaId);

  return (
    <Surface variant="transparent" className="flex min-h-0 flex-1 rounded-none bg-app-panel">
      <div
        className="app-drag absolute top-0 left-0 z-10 h-14"
        style={{
          width: `${sidebarClosedPaddingLeft}px`
        }}
      />

      <IdeasBacklogList
        ideas={ideas}
        isLoading={isLoading}
        onCreateIdea={onCreateIdea}
        onSelectIdea={onSelectIdea}
        onToggleClosedIssues={onToggleClosedIssues}
        selectedIdeaId={selectedIdeaId}
        showClosedIssues={showClosedIssues}
        syncErrors={syncErrors}
      />

      <div className="min-h-0 min-w-0 flex-1">
        {loadError ? (
          <div className="px-8 pt-6">
            <Surface
              variant="tertiary"
              className="rounded-2xl border border-zinc-400/25 bg-zinc-500/10 px-4 py-3 text-sm text-zinc-200"
            >
              {loadError}
            </Surface>
          </div>
        ) : null}

        <IdeaEditor
          candidateIdeas={candidateIdeas}
          draftValues={draftValues}
          exportMessage={ideaExportMessage}
          isDirty={isDirty}
          isExporting={isIdeaExporting}
          isSaving={isSaving}
          onExportToWorktree={onExportIdeaToWorktree}
          onSave={onSaveIdea}
          onSelectIdeaToEvolve={(ideaId) => {
            onUpdateIdeaValue('evolvesIdeaId', ideaId);
          }}
          onUpdateValue={onUpdateIdeaValue}
          selectedIdea={selectedIdea}
          selectedWorktree={selectedWorktree}
          syncError={selectedIdea ? syncErrors[selectedIdea.id] : undefined}
        />
      </div>
    </Surface>
  );
}
