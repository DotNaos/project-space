import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import {
  ModalBackdrop,
  ModalBody,
  ModalCloseTrigger,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  ModalHeading,
  ModalRoot
} from '@heroui/react';

import { Button, Text } from '@/app/dotnaos-ui';
import { isPullRequestChangelogIdentity } from '@/shared/pr-preview-changelog-api';
import type { PullRequestPreviewBuildMetadata } from '@/shared/project-space-api';
import type { PullRequestChangelogTestTargetsSnapshot } from '@/shared/pr-preview-changelog-test-targets';
import { PullRequestChangelogSummary } from './pull-request-changelog-summary';
import { pullRequestChangelogSnapshotFor } from './pull-request-changelog-snapshot';
import {
  dismissPreviewChangelog,
  shouldOpenPreviewChangelog,
  type PreviewChangelogDismissalStorage
} from './pull-request-changelog-dialog-state';

export interface PullRequestChangelogDialogProps {
  openRequestId?: number;
  preview?: PullRequestPreviewBuildMetadata;
  storage?: PreviewChangelogDismissalStorage;
  testTargets?: PullRequestChangelogTestTargetsSnapshot;
}

function browserSessionStorage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export function PullRequestChangelogDialog({
  openRequestId = 0,
  preview,
  storage = browserSessionStorage(),
  testTargets
}: PullRequestChangelogDialogProps) {
  const identity =
    preview?.state === 'verified' &&
    isPullRequestChangelogIdentity(preview.identity)
      ? preview.identity
      : undefined;
  const hasInvalidMetadata = Boolean(preview && !identity);
  const identityKey = identity
    ? `${identity.repositoryFullName}:${identity.pullRequestNumber}:${identity.headSha}`
    : preview
      ? `invalid:${preview.state}`
      : '';
  const previousOpenRequestId = useRef(openRequestId);
  const [isOpen, setIsOpen] = useState(
    () =>
      hasInvalidMetadata ||
      openRequestId > 0 ||
      Boolean(
        identity &&
          shouldOpenPreviewChangelog(identity, storage)
      )
  );

  useEffect(() => {
    setIsOpen(
      hasInvalidMetadata ||
        Boolean(
          identity &&
            shouldOpenPreviewChangelog(identity, storage)
        )
    );
  }, [hasInvalidMetadata, identityKey, storage]);

  useEffect(() => {
    if (openRequestId === previousOpenRequestId.current) {
      return;
    }

    previousOpenRequestId.current = openRequestId;
    setIsOpen(true);
  }, [openRequestId]);

  if (!preview) {
    return null;
  }

  const snapshot = identity
    ? pullRequestChangelogSnapshotFor(identity)
    : undefined;

  function changeOpen(nextOpen: boolean) {
    setIsOpen(nextOpen);
    if (!nextOpen && identity) {
      dismissPreviewChangelog(identity, storage);
    }
  }

  return (
    <ModalRoot isOpen={isOpen} onOpenChange={changeOpen}>
      <ModalBackdrop
        className="z-[140] bg-black/75"
        variant="blur"
      >
        <ModalContainer
          className="p-3 sm:p-5"
          placement="center"
          scroll="inside"
          size="sm"
        >
          <ModalDialog className="max-h-[min(36rem,calc(100dvh-1.5rem))] overflow-hidden border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/70 sm:max-w-lg">
            <ModalCloseTrigger aria-label="Close preview changelog" />
            <ModalHeader className="block px-5 pb-2 pr-12 pt-5">
              <ModalHeading className="text-lg font-semibold tracking-tight">
                {identity
                  ? 'Changes in this Preview'
                  : 'Changelog unavailable'}
              </ModalHeading>
              {identity ? (
                <Text className="mt-1 block text-xs leading-5 text-neutral-500">
                  PR #{identity.pullRequestNumber} ·{' '}
                  {identity.headSha.slice(0, 8)}
                </Text>
              ) : null}
            </ModalHeader>

            <ModalBody className="px-5 pb-2 pt-2">
              {identity && snapshot ? (
                <PullRequestChangelogSummary
                  expectedIdentity={identity}
                  showDocsLink={false}
                  snapshot={snapshot}
                  testTargets={testTargets}
                />
              ) : (
                <p
                  className="text-sm leading-6 text-neutral-400"
                  role="alert"
                >
                  This Preview could not verify its pull request identity, so
                  no changelog or testing links are shown.
                </p>
              )}
            </ModalBody>

            <ModalFooter className="justify-between gap-3 px-5 pb-5 pt-3">
              {identity && snapshot?.docsHref ? (
                <a
                  className="inline-flex min-h-8 items-center gap-1.5 text-xs font-medium text-neutral-400 underline-offset-4 hover:text-neutral-200 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
                  href={snapshot.docsHref}
                >
                  Full changelog
                  <ExternalLink aria-hidden className="size-3.5" />
                </a>
              ) : (
                <span />
              )}
              <Button
                aria-label="Dismiss preview changelog"
                onPress={() => changeOpen(false)}
                size="sm"
                variant="ghost"
              >
                <Check aria-hidden className="size-3.5" />
                Dismiss
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </ModalRoot>
  );
}
