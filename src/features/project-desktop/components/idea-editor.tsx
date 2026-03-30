import {
  Button,
  Card,
  Input,
  ScrollShadow,
  Surface,
  Text,
  TextArea
} from '@heroui/react';
import { ExternalLink, RefreshCw, Save } from 'lucide-react';

import { getIdeaStateMeta, type EditableIdeaValues, type IdeaPresentationRecord } from '../lib/idea-utils';

interface IdeaEditorProps {
  assignedIdeaIds: string[];
  draftValues: EditableIdeaValues;
  isDirty: boolean;
  isSaving: boolean;
  onSave(): void;
  onUpdateValue<Key extends keyof EditableIdeaValues>(
    key: Key,
    value: EditableIdeaValues[Key]
  ): void;
  selectedIdea?: IdeaPresentationRecord;
  syncError?: string;
}

function formatSourceLabel(idea: IdeaPresentationRecord) {
  return idea.source === 'github' ? `GitHub #${idea.githubIssueNumber}` : 'Local draft';
}

export function IdeaEditor({
  assignedIdeaIds,
  draftValues,
  isDirty,
  isSaving,
  onSave,
  onUpdateValue,
  selectedIdea,
  syncError
}: IdeaEditorProps) {
  if (!selectedIdea) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <Card variant="secondary" className="w-full max-w-xl border border-zinc-800/80 bg-zinc-950/60">
          <Card.Header className="gap-3">
            <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
              Ideas
            </Text>
            <Card.Title className="text-2xl font-semibold tracking-tight text-zinc-50">
              Select or create an idea
            </Card.Title>
            <Card.Description className="text-base text-zinc-400">
              Start with a rough local note, then give it a title when you want it pushed to
              GitHub.
            </Card.Description>
          </Card.Header>
        </Card>
      </div>
    );
  }

  const canSave = selectedIdea.source === 'local' || Boolean(draftValues.title.trim());
  const state = getIdeaStateMeta(selectedIdea, {
    assignedToWorktree: assignedIdeaIds.includes(selectedIdea.id)
  });
  const titlePlaceholder =
    selectedIdea.source === 'github'
      ? 'Give this idea a clear title'
      : 'Start with a title when you are ready to publish';

  return (
    <ScrollShadow className="min-h-0 flex-1 px-8 py-8" hideScrollBar>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-[28rem]">
            <div className="flex flex-wrap items-center gap-2">
              {selectedIdea.githubIssueUrl ? (
                <a
                  href={selectedIdea.githubIssueUrl}
                  rel="noreferrer"
                  target="_blank"
                  className="inline-flex max-w-full items-center gap-2 text-sm text-zinc-300 transition hover:text-zinc-200"
                >
                  <ExternalLink className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                  <span className="truncate">{formatSourceLabel(selectedIdea)}</span>
                </a>
              ) : (
                <Text className="truncate text-sm text-zinc-500">{formatSourceLabel(selectedIdea)}</Text>
              )}

              <span
                className={
                  state.id === 'in-worktree'
                    ? 'rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-950'
                    : state.id === 'ready'
                      ? 'rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-200'
                      : state.id === 'closed'
                        ? 'rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500'
                        : 'rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-400'
                }
              >
                {state.label}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              isDisabled={!canSave}
              onPress={onSave}
              className="h-11 rounded-2xl bg-zinc-100 px-4 text-zinc-950 hover:bg-zinc-200"
            >
              {isSaving ? (
                <RefreshCw className="h-4 w-4 animate-spin" strokeWidth={1.9} />
              ) : (
                <Save className="h-4 w-4" strokeWidth={1.9} />
              )}
              <span>{selectedIdea.source === 'local' ? 'Save idea' : 'Save changes'}</span>
            </Button>
          </div>
        </div>

        {syncError ? (
          <Surface
            variant="tertiary"
            className="rounded-2xl border border-zinc-400/25 bg-zinc-500/10 px-4 py-3 text-sm text-zinc-200"
          >
            {syncError}
          </Surface>
        ) : null}

        <div className="space-y-8">
          <div className="space-y-8">
            <div className="space-y-6">
              <Input
                aria-label="Idea title"
                fullWidth
                placeholder={titlePlaceholder}
                value={draftValues.title}
                variant="secondary"
                onChange={(event) => {
                  onUpdateValue('title', event.currentTarget.value);
                }}
                className="rounded-2xl border border-transparent bg-transparent px-4 py-3 text-3xl font-semibold tracking-tight text-zinc-50 placeholder:text-zinc-600 shadow-none outline-none ring-0 transition-colors duration-200 focus:border-zinc-800/90 focus:bg-zinc-950/28 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 data-[focus-visible=true]:border-zinc-800/90 data-[focus-visible=true]:bg-zinc-950/28 data-[focus-visible=true]:shadow-none"
              />

              <TextArea
                aria-label="Idea description"
                fullWidth
                placeholder={`## Goal\n\nExplain the problem, the intended change, and any constraints.\n\n- What changes?\n- Why now?\n- What should be true afterwards?`}
                rows={14}
                value={draftValues.body}
                variant="secondary"
                onChange={(event) => {
                  onUpdateValue('body', event.currentTarget.value);
                }}
                className="min-h-[24rem] rounded-2xl border border-transparent bg-transparent px-4 py-3 font-mono text-[15px] leading-7 text-zinc-200 placeholder:text-zinc-600 shadow-none outline-none ring-0 transition-colors duration-200 focus:border-zinc-800/90 focus:bg-zinc-950/28 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 data-[focus-visible=true]:border-zinc-800/90 data-[focus-visible=true]:bg-zinc-950/28 data-[focus-visible=true]:shadow-none"
              />
            </div>

            {isDirty ? (
              <Surface
                variant="tertiary"
                className="rounded-2xl border border-zinc-400/25 bg-zinc-500/10 px-4 py-3 text-sm text-zinc-200"
              >
                Unsaved changes are ready to be saved.
              </Surface>
            ) : null}
          </div>
        </div>
      </div>
    </ScrollShadow>
  );
}
