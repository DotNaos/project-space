import { useState } from 'react';
import {
  Pencil,
  Save,
  X
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import {
  Button,
  Text,
  ToggleButton,
  ToggleButtonGroup
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { GitHubIssueRecord } from '@/shared/project-space-api';
import { issueUpdatedAtLabel } from './issue-board-model';
import { IssueMarkdown } from './issue-markdown';
import { IssueAuthorAvatar, IssueLabelChip } from './issue-visuals';

interface IssueBodyProps {
  issue: GitHubIssueRecord;
  onIssueUpdated(issue: GitHubIssueRecord): void;
  repoFullName?: string;
}

export function IssueBody({ issue, onIssueUpdated, repoFullName }: IssueBodyProps) {
  const updated = issueUpdatedAtLabel(issue);
  const [isEditing, setIsEditing] = useState(false);
  const [editError, setEditError] = useState('');

  const updateIssue = async (values: IssueFormValues) => {
    if (!repoFullName) {
      return;
    }

    setEditError('');
    const result = await projectSpaceClient.updateGitHubIssue({
      body: values.body,
      fullName: repoFullName,
      labels: values.labels,
      number: issue.number,
      state: values.state,
      title: values.title
    });

    if (result.status !== 'connected' || !result.issue) {
      setEditError(result.message ?? 'Could not edit issue.');
      return;
    }

    onIssueUpdated(result.issue);
    setIsEditing(false);
  };

  return (
    <article className="issue-rise-in min-h-0 min-w-0 overflow-y-auto pr-3">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
            issue.state === 'open'
              ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
              : 'border-neutral-700 bg-neutral-800/60 text-neutral-400'
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              issue.state === 'open' ? 'bg-emerald-400' : 'bg-neutral-500'
            )}
          />
          {issue.state}
        </span>
      </div>

      <div className="flex min-w-0 items-start gap-3">
        <Text
          as="h1"
          className="min-w-0 flex-1 text-2xl font-semibold leading-tight tracking-tight text-neutral-50"
        >
          <span className="mr-2 font-mono text-lg font-medium tabular-nums text-neutral-500">
            #{issue.number}
          </span>
          {issue.title}
        </Text>
        {repoFullName ? (
          <Button
            size="sm"
            variant="ghost"
            className="mt-0.5 shrink-0"
            onPress={() => {
              setEditError('');
              setIsEditing((value) => !value);
            }}
          >
            {isEditing ? <X className="size-4" /> : <Pencil className="size-4" />}
            {isEditing ? 'Cancel edit' : 'Edit'}
          </Button>
        ) : null}
      </div>

      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {issue.author ? (
          <span className="flex items-center gap-1.5">
            <IssueAuthorAvatar author={issue.author} className="size-5 text-[10px]" />
            <Text className="text-xs text-neutral-400">{issue.author}</Text>
          </span>
        ) : null}
        {updated ? (
          <Text className="font-mono text-[11px] text-neutral-600">updated {updated} ago</Text>
        ) : null}
      </div>

      {issue.labels.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {issue.labels.map((label) => (
            <IssueLabelChip key={label} label={label} className="text-[11px]" />
          ))}
        </div>
      ) : null}

      <div className="mt-5 h-px bg-neutral-800/80" />

      {isEditing ? (
        <IssueEditor
          error={editError}
          initialBody={issue.body ?? ''}
          initialLabels={issue.labels}
          initialState={issue.state}
          initialTitle={issue.title}
          onCancel={() => {
            setEditError('');
            setIsEditing(false);
          }}
          onSubmit={updateIssue}
          showState
          submitLabel="Save issue"
        />
      ) : (
        <IssueMarkdown markdown={issue.body} />
      )}
    </article>
  );
}

export interface IssueFormValues {
  body: string;
  labels: string[];
  state?: GitHubIssueRecord['state'];
  title: string;
}

function labelsFromInput(value: string) {
  return value
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
}

export function IssueEditor({
  error,
  initialBody,
  initialLabels,
  initialState,
  initialTitle,
  onCancel,
  onSubmit,
  showState = false,
  submitLabel
}: {
  error: string;
  initialBody: string;
  initialLabels: string[];
  initialState?: GitHubIssueRecord['state'];
  initialTitle: string;
  onCancel(): void;
  onSubmit(values: IssueFormValues): Promise<void>;
  showState?: boolean;
  submitLabel: string;
}) {
  const [body, setBody] = useState(initialBody);
  const [labels, setLabels] = useState(initialLabels.join(', '));
  const [state, setState] = useState<GitHubIssueRecord['state']>(initialState ?? 'open');
  const [title, setTitle] = useState(initialTitle);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async () => {
    setIsSubmitting(true);
    try {
      await onSubmit({
        body,
        labels: labelsFromInput(labels),
        state: showState ? state : undefined,
        title
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="issue-rise-in mb-4 rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
      <div className="grid gap-2">
        <input
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          placeholder="Issue title"
          className="h-9 rounded-lg border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-neutral-600"
        />
        <textarea
          value={body}
          onChange={(event) => setBody(event.currentTarget.value)}
          placeholder="Markdown description"
          rows={8}
          className="min-h-40 resize-y rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm leading-6 text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-neutral-600"
        />
        <input
          value={labels}
          onChange={(event) => setLabels(event.currentTarget.value)}
          placeholder="Labels, comma separated"
          className="h-9 rounded-lg border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-neutral-600"
        />
        {showState ? (
          <div className="flex items-center gap-2">
            <Text className="w-14 text-xs text-neutral-500">State</Text>
            <ToggleButtonGroup
              aria-label="Issue state"
              selectedKeys={new Set([state])}
              onSelectionChange={(keys) => {
                const nextState = Array.from(keys)[0];

                if (nextState === 'open' || nextState === 'closed') {
                  setState(nextState);
                }
              }}
              className="rounded-lg bg-neutral-900/70 p-1"
            >
              <ToggleButton id="open" className="h-7 gap-1.5 rounded-md px-2 text-xs">
                Open
              </ToggleButton>
              <ToggleButton id="closed" className="h-7 gap-1.5 rounded-md px-2 text-xs">
                Closed
              </ToggleButton>
            </ToggleButtonGroup>
          </div>
        ) : null}
      </div>
      {error ? <Text className="mt-2 block text-xs text-red-300">{error}</Text> : null}
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onPress={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          isDisabled={isSubmitting || !title.trim()}
          variant="primary"
          onPress={() => void submit()}
        >
          <Save className="size-4" />
          {isSubmitting ? 'Saving...' : submitLabel}
        </Button>
      </div>
    </div>
  );
}
