import { useEffect, useState } from 'react';
import { BookOpenText, TriangleAlert } from 'lucide-react';
import {
  ModalBackdrop,
  ModalBody,
  ModalCloseTrigger,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  ModalHeading,
  ModalIcon,
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
  const [isOpen, setIsOpen] = useState(
    () =>
      hasInvalidMetadata ||
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
          placement="auto"
          scroll="inside"
          size="md"
        >
          <ModalDialog className="max-h-[min(44rem,calc(100dvh-1.5rem))] overflow-hidden border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/70 sm:max-w-xl">
            <ModalCloseTrigger aria-label="Close preview changelog" />
            <ModalHeader className="flex-row items-start gap-3 border-b border-neutral-900 px-5 py-4 sm:px-6">
              <ModalIcon className="bg-sky-500/10 text-sky-300">
                {identity ? (
                  <BookOpenText aria-hidden className="size-5" />
                ) : (
                  <TriangleAlert aria-hidden className="size-5 text-amber-300" />
                )}
              </ModalIcon>
              <div className="min-w-0">
                <ModalHeading className="text-lg font-semibold">
                  {identity
                    ? `What changed in PR #${identity.pullRequestNumber}`
                    : 'Preview changelog unavailable'}
                </ModalHeading>
                <Text className="mt-1 block text-xs leading-5 text-neutral-500">
                  {identity
                    ? `From this Preview's exact source revision ${identity.headSha.slice(0, 8)}.`
                    : 'This Preview could not verify its pull request build identity.'}
                </Text>
              </div>
            </ModalHeader>

            <ModalBody className="px-3 py-3 sm:px-4 sm:py-4">
              {identity && snapshot ? (
                <PullRequestChangelogSummary
                  expectedIdentity={identity}
                  snapshot={snapshot}
                  testTargets={testTargets}
                />
              ) : (
                <div
                  className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-4 text-sm leading-6 text-neutral-300"
                  role="alert"
                >
                  No changelog entries or testing links are shown because the
                  deployed repository, pull request, commit, and running build
                  could not be matched exactly.
                </div>
              )}
            </ModalBody>

            <ModalFooter className="border-t border-neutral-900 px-5 py-3 sm:px-6">
              <Button
                className="w-full sm:w-auto"
                onPress={() => changeOpen(false)}
                size="sm"
                variant="secondary"
              >
                Continue to Preview
              </Button>
            </ModalFooter>
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </ModalRoot>
  );
}
