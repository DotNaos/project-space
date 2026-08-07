import { useState } from 'react';
import { CircleAlert, ExternalLink, Loader2, X } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import type { GitHubIssueCreationResult } from '@/shared/project-space-api';
import { projectTemplateRepository } from './template-contract-model';

function createOperationId() {
  return globalThis.crypto?.randomUUID?.() ?? `template-feature-${Date.now()}`;
}

export function TemplateFeatureDialog({
  branch,
  contextPath,
  onClose
}: {
  branch: string;
  /** Prefills the body with the file the reader was looking at. */
  contextPath?: string;
  onClose(): void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [created, setCreated] = useState<GitHubIssueCreationResult>();

  async function submit() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || isSending) return;
    setError('');
    setIsSending(true);
    try {
      const contextLines = [
        body.trim(),
        '',
        `Branch: \`${branch}\``,
        ...(contextPath ? [`Path: \`${contextPath}\``] : [])
      ].join('\n').trim();
      const result = await projectSpaceClient.createGitHubIssue({
        body: contextLines,
        fullName: projectTemplateRepository,
        operationId: createOperationId(),
        title: trimmedTitle
      });
      if (result.creationState === 'complete' && result.issue) {
        setCreated(result);
        return;
      }
      setError(result.message ?? 'The issue could not be created.');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'The issue could not be created.');
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div
      aria-label="New template feature"
      aria-modal="true"
      className="fixed inset-0 z-[80] grid place-items-center p-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      role="dialog"
    >
      <button
        aria-hidden
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <div className="relative flex w-full max-w-lg flex-col gap-4 rounded-2xl bg-neutral-950 p-5 ring-1 ring-inset ring-white/10">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Text as="h2" className="block text-base font-medium text-neutral-100">
              New template feature
            </Text>
            <Text className="mt-1 block truncate text-sm text-neutral-500">
              Opens an issue on {projectTemplateRepository}
            </Text>
          </div>
          <Button
            aria-label="Close"
            className="size-8 min-h-0 shrink-0"
            isIconOnly
            onPress={onClose}
            size="sm"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </div>

        {created?.issue ? (
          <div className="grid gap-3">
            <Text className="block text-sm text-neutral-400">
              Created #{created.issue.number} — {created.issue.title}
            </Text>
            <div className="flex flex-wrap gap-2">
              {created.issue.url ? (
                <a href={created.issue.url} rel="noreferrer" target="_blank">
                  <Button size="sm" variant="secondary">
                    Open on GitHub <ExternalLink className="size-3.5" />
                  </Button>
                </a>
              ) : null}
              <Button onPress={onClose} size="sm" variant="ghost">Done</Button>
            </div>
          </div>
        ) : (
          <>
            <label className="grid gap-1.5">
              <Text className="text-[11px] font-medium text-neutral-600">
                What should every project have?
              </Text>
              <input
                autoFocus
                className="h-10 rounded-xl bg-white/[.05] px-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:bg-white/[.07]"
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder="Every project ships a health endpoint"
                value={title}
              />
            </label>
            <label className="grid gap-1.5">
              <Text className="text-[11px] font-medium text-neutral-600">Why, and what it covers</Text>
              <textarea
                className="min-h-28 resize-y rounded-xl bg-white/[.05] px-3 py-2 text-sm leading-6 text-neutral-100 outline-none placeholder:text-neutral-600 focus:bg-white/[.07]"
                onChange={(event) => setBody(event.currentTarget.value)}
                placeholder="What the template should own, and what a project may still change."
                value={body}
              />
            </label>

            {error ? (
              <div className="flex items-start gap-2 text-xs text-red-300/90" role="alert">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                {error}
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button onPress={onClose} size="sm" variant="ghost">Cancel</Button>
              <Button
                isDisabled={!title.trim() || isSending}
                onPress={() => void submit()}
                size="sm"
                variant="primary"
              >
                {isSending ? <Loader2 className="size-4 animate-spin" /> : null}
                Create issue
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
