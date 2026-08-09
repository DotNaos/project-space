import { useEffect, useState } from 'react';
import { Check, ExternalLink, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button, Modal } from '@heroui/react';

import { CodexMarkdownMessage } from '@/features/codex-sessions/codex-markdown-message';
import type { ReleaseChangelogEntry } from '@/shared/release-changelog-api';
import { ReleaseVersionTree } from './release-version-tree-view';

export function ReleaseChangelogDialog({
  currentVersion,
  error,
  isLoading,
  isOpen,
  onClose,
  onDismissCurrent,
  onSelect,
  releases,
  selectedRelease,
  selectedVersion
}: {
  currentVersion?: string;
  error: string;
  isLoading: boolean;
  isOpen: boolean;
  onClose(): void;
  onDismissCurrent(): void;
  onSelect(version: string): void;
  releases: ReleaseChangelogEntry[];
  selectedRelease?: ReleaseChangelogEntry;
  selectedVersion?: string;
}) {
  const [isTreeOpen, setIsTreeOpen] = useState(false);

  useEffect(() => {
    if (isOpen) setIsTreeOpen(false);
  }, [isOpen]);

  const viewingCurrent = Boolean(
    currentVersion && selectedVersion === currentVersion
  );
  const displayVersion = selectedVersion ?? currentVersion;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Backdrop className="z-[140] bg-black/75" variant="blur">
        <Modal.Container className="p-0 sm:p-5" placement="center" scroll="inside" size="lg">
          <Modal.Dialog className="flex h-[min(46rem,calc(100dvh-0.75rem))] max-h-[calc(100dvh-0.75rem)] w-full max-w-none flex-col overflow-hidden rounded-t-[1.75rem] rounded-b-none border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/70 sm:h-auto sm:max-h-[min(46rem,92dvh)] sm:max-w-4xl sm:rounded-2xl">
            <Modal.Header className="flex-row items-start gap-3 border-b border-neutral-800 px-4 py-4 pr-12 sm:px-5">
              <Button
                aria-label={isTreeOpen ? 'Collapse version history' : 'Expand version history'}
                className="mt-0.5 size-8 min-w-8 text-neutral-500 hover:text-neutral-100"
                isDisabled={releases.length === 0}
                isIconOnly
                onPress={() => setIsTreeOpen((current) => !current)}
                size="sm"
                variant="ghost"
              >
                {isTreeOpen ? (
                  <PanelLeftClose className="size-4" />
                ) : (
                  <PanelLeftOpen className="size-4" />
                )}
              </Button>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                  {selectedRelease ? (
                    <time dateTime={selectedRelease.publishedAt}>
                      {formatReleaseDate(selectedRelease.publishedAt)}
                    </time>
                  ) : null}
                  {displayVersion ? (
                    <span className="rounded-md bg-white/[.06] px-2 py-0.5 font-medium text-neutral-300">
                      v{displayVersion}
                    </span>
                  ) : null}
                </div>
                <Modal.Heading className="mt-1.5 truncate text-lg font-semibold tracking-tight sm:text-xl">
                  {selectedRelease?.name ?? 'Project Space changelog'}
                </Modal.Heading>
              </div>
              <Modal.CloseTrigger aria-label="Close changelog" className="text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100" />
            </Modal.Header>

            <Modal.Body className="flex min-h-0 flex-1 overflow-hidden p-0">
              <div className="flex min-h-0 w-full flex-1 flex-col sm:flex-row">
                {isTreeOpen ? (
                  <aside className="max-h-52 shrink-0 overflow-y-auto border-b border-neutral-800 px-3 py-3 sm:max-h-none sm:w-56 sm:border-r sm:border-b-0">
                    <p className="px-2 pb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-neutral-600">
                      Versions
                    </p>
                    <ReleaseVersionTree
                      onSelect={onSelect}
                      releases={releases}
                      selectedVersion={selectedVersion}
                    />
                  </aside>
                ) : null}

                <article className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8 sm:py-7">
                  {isLoading ? (
                    <div className="flex min-h-56 items-center justify-center gap-3 text-sm text-neutral-500">
                      <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-200" />
                      Loading release notes…
                    </div>
                  ) : error ? (
                    <EmptyReleaseState
                      message={error}
                      title="Release notes are temporarily unavailable"
                    />
                  ) : selectedRelease?.body ? (
                    <CodexMarkdownMessage
                      className="text-sm leading-7 text-neutral-300"
                      text={selectedRelease.body}
                    />
                  ) : selectedRelease ? (
                    <EmptyReleaseState
                      message="No release notes were published for this version."
                      title="No details for this release"
                    />
                  ) : (
                    <EmptyReleaseState
                      message={displayVersion
                        ? `Project Space is running v${displayVersion}, but no matching published release notes were found. You can still open the version tree to browse earlier releases.`
                        : 'No published release notes were found.'}
                      title="No release notes for this version"
                    />
                  )}
                </article>
              </div>
            </Modal.Body>

            <Modal.Footer className="flex-row items-center justify-between gap-3 border-t border-neutral-800 px-5 py-4 sm:px-6">
              {selectedRelease ? (
                <a
                  className="inline-flex min-h-8 items-center gap-1.5 text-xs font-medium text-neutral-500 underline-offset-4 hover:text-neutral-200 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
                  href={selectedRelease.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  View on GitHub
                  <ExternalLink aria-hidden className="size-3.5" />
                </a>
              ) : <span />}
              {viewingCurrent ? (
                <Button
                  onPress={() => {
                    onDismissCurrent();
                    onClose();
                  }}
                  size="sm"
                  variant="ghost"
                >
                  <Check aria-hidden className="size-3.5" />
                  Dismiss v{currentVersion}
                </Button>
              ) : (
                <Button onPress={onClose} size="sm" variant="ghost">
                  Close
                </Button>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function EmptyReleaseState({ message, title }: { message: string; title: string }) {
  return (
    <div className="mx-auto flex min-h-56 max-w-md flex-col justify-center">
      <h3 className="text-base font-semibold text-neutral-200">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-neutral-500">{message}</p>
    </div>
  );
}

function formatReleaseDate(value: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(new Date(value));
  } catch {
    return value;
  }
}
