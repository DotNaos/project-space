import {
  Button,
  Card,
  Input,
  ListBox,
  ListBoxItem,
  ScrollShadow,
  Surface,
  Text,
  TextArea
} from '@heroui/react';
import { ExternalLink, RefreshCw, Save, Share2 } from 'lucide-react';

import type { ProjectWorktreeRecord } from '@/shared/electron-api';

import { renderMarkdownToHtml } from '../lib/markdown-preview';
import type { EditableIdeaValues, IdeaPresentationRecord } from '../lib/idea-utils';

interface IdeaEditorProps {
  candidateIdeas: IdeaPresentationRecord[];
  draftValues: EditableIdeaValues;
  exportMessage: string;
  isDirty: boolean;
  isExporting: boolean;
  isSaving: boolean;
  onExportToWorktree(): void;
  onSave(): void;
  onSelectIdeaToEvolve(ideaId: string): void;
  onUpdateValue<Key extends keyof EditableIdeaValues>(
    key: Key,
    value: EditableIdeaValues[Key]
  ): void;
  selectedIdea?: IdeaPresentationRecord;
  selectedWorktree?: ProjectWorktreeRecord;
  syncError?: string;
}

function formatSourceLabel(idea: IdeaPresentationRecord) {
  return idea.source === 'github' ? `GitHub #${idea.githubIssueNumber}` : 'Local draft';
}

function renderChecklistState(value: boolean) {
  return value ? 'Ready' : 'Missing';
}

export function IdeaEditor({
  candidateIdeas,
  draftValues,
  exportMessage,
  isDirty,
  isExporting,
  isSaving,
  onExportToWorktree,
  onSave,
  onSelectIdeaToEvolve,
  onUpdateValue,
  selectedIdea,
  selectedWorktree,
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
  const canExport =
    selectedIdea.source === 'github' &&
    selectedIdea.qualityGate.isReady &&
    Boolean(selectedWorktree);
  const previewHtml = renderMarkdownToHtml(draftValues.body);
  const qualityGate = {
    hasDescription: Boolean(draftValues.body.trim()),
    hasIteration: Boolean(draftValues.iteration.trim()),
    hasTitle: Boolean(draftValues.title.trim())
  };
  const isReady = qualityGate.hasTitle && qualityGate.hasDescription && qualityGate.hasIteration;
  const titlePlaceholder =
    selectedIdea.source === 'github'
      ? 'Give this idea a clear title'
      : 'Start with a title when you are ready to publish';

  return (
    <ScrollShadow className="min-h-0 flex-1 px-8 py-8" hideScrollBar>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-[28rem]">
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
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              isDisabled={!canExport || isExporting}
              onPress={onExportToWorktree}
              className="h-11 rounded-2xl border border-zinc-800/80 bg-zinc-950/70 px-4 text-zinc-200"
            >
              {isExporting ? (
                <RefreshCw className="h-4 w-4 animate-spin" strokeWidth={1.9} />
              ) : (
                <Share2 className="h-4 w-4" strokeWidth={1.9} />
              )}
              <span>{selectedWorktree ? 'Export' : 'Choose worktree'}</span>
            </Button>

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
                className="rounded-none border-0 bg-transparent px-0 py-2 text-3xl font-semibold tracking-tight text-zinc-50 placeholder:text-zinc-600 shadow-none"
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
                className="min-h-[24rem] rounded-[1.6rem] border border-zinc-800/60 bg-zinc-950/62 px-5 py-4 font-mono text-[15px] leading-7 text-zinc-200 placeholder:text-zinc-600"
              />
            </div>

            <div className="space-y-3 border-t border-zinc-800/80 pt-6">
              <Text className="text-sm font-medium text-zinc-400">Preview</Text>
              <div
                className="space-y-4 border-t border-zinc-800/80 pt-4"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            </div>

            <div className="space-y-4 border-t border-zinc-800/80 pt-6">
              <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
                <div className="space-y-2">
                  <Input
                    aria-label="Iteration"
                    placeholder="Iteration 1"
                    value={draftValues.iteration}
                    onChange={(event) => {
                      onUpdateValue('iteration', event.currentTarget.value);
                    }}
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-4 text-sm">
                    <Text className={qualityGate.hasTitle ? 'text-zinc-300' : 'text-zinc-500'}>
                      Title: {renderChecklistState(qualityGate.hasTitle)}
                    </Text>
                    <Text
                      className={qualityGate.hasDescription ? 'text-zinc-300' : 'text-zinc-500'}
                    >
                      Description: {renderChecklistState(qualityGate.hasDescription)}
                    </Text>
                    <Text className={qualityGate.hasIteration ? 'text-zinc-300' : 'text-zinc-500'}>
                      Iteration: {renderChecklistState(qualityGate.hasIteration)}
                    </Text>
                  </div>
                  <Text
                    className={
                      isReady
                        ? 'mt-4 text-sm text-zinc-300'
                        : 'mt-4 text-sm text-zinc-500'
                    }
                  >
                    {isReady
                      ? 'This idea is ready to be exported into a worktree.'
                      : 'Finish the missing pieces before turning this into worktree context.'}
                  </Text>
                </div>
              </div>

              <ScrollShadow className="max-h-72 rounded-2xl border border-zinc-800 bg-zinc-950/20 p-2" hideScrollBar>
                {candidateIdeas.length > 0 ? (
                  <ListBox
                    aria-label="Select idea lineage"
                    className="space-y-1"
                    selectedKeys={
                      draftValues.evolvesIdeaId
                        ? new Set([draftValues.evolvesIdeaId])
                        : new Set()
                    }
                    selectionMode="single"
                    onAction={(key) => {
                      onSelectIdeaToEvolve(String(key));
                    }}
                  >
                    {candidateIdeas.map((idea) => (
                      <ListBoxItem
                        key={idea.id}
                        id={idea.id}
                        textValue={idea.title.trim() || 'Untitled idea'}
                        className="rounded-xl text-zinc-300 hover:bg-zinc-900/60 hover:text-zinc-50"
                      >
                        <div className="space-y-1 px-2 py-2">
                          <Text className="truncate text-sm font-medium text-current">
                            {idea.title.trim() || 'Untitled idea'}
                          </Text>
                          <Text className="text-xs text-zinc-500">
                            {idea.iteration.trim() || 'No iteration yet'}
                          </Text>
                        </div>
                      </ListBoxItem>
                    ))}
                  </ListBox>
                ) : (
                  <div className="px-2 py-3">
                    <Text className="text-sm text-zinc-500">
                      No other ideas yet. Create a second idea when you want to show a lineage.
                    </Text>
                  </div>
                )}
              </ScrollShadow>

              <Button
                variant="ghost"
                onPress={() => {
                  onUpdateValue('evolvesIdeaId', '');
                }}
                className="h-10 justify-start rounded-2xl px-3 text-zinc-300 hover:bg-zinc-900/40 hover:text-zinc-50"
              >
                Clear parent link
              </Button>
            </div>

            {exportMessage ? (
              <Surface
                variant="tertiary"
                className="rounded-2xl border border-zinc-400/20 bg-zinc-500/10 px-4 py-3 text-sm text-zinc-300"
              >
                {exportMessage}
              </Surface>
            ) : null}

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
