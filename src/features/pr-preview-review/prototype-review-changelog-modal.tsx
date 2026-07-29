import { Modal } from '@heroui/react';
import { FileClock } from 'lucide-react';

import { Text } from '@/app/dotnaos-ui';
import { PullRequestChangelogSummary } from '@/features/pr-preview-changelog/pull-request-changelog-summary';
import { pullRequestChangelogSnapshotFor } from '@/features/pr-preview-changelog/pull-request-changelog-snapshot';
import type { PullRequestTestSurfacesResult } from '@/shared/pr-preview-test-surfaces-api';
import type { PrototypeTheme } from '@/shared/prototype-canvas';
import type { PrototypeReviewLocalContext } from '@/shared/prototype-review-local-api';
import { prototypeReviewChangelogIdentity } from './prototype-review-changelog';

interface PrototypeReviewChangelogModalProps {
  isOpen: boolean;
  localContext?: PrototypeReviewLocalContext;
  onOpenChange(open: boolean): void;
  pullRequestNumber?: number;
  repositoryFullName?: string;
  result?: PullRequestTestSurfacesResult;
  theme: PrototypeTheme;
}

export function PrototypeReviewChangelogModal({
  isOpen,
  localContext,
  onOpenChange,
  pullRequestNumber,
  repositoryFullName,
  result,
  theme
}: PrototypeReviewChangelogModalProps) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop className="z-[90] bg-black/75" variant="blur">
        <Modal.Container className="p-3" placement="center" scroll="inside" size="lg">
          <Modal.Dialog className={`flex max-h-[min(44rem,88dvh)] flex-col overflow-hidden ${
            theme === 'dark'
              ? 'bg-neutral-950 text-neutral-100'
              : 'bg-stone-50 text-neutral-900'
          }`}>
            <Modal.CloseTrigger aria-label="Close pull request changelog" />
            <Modal.Header className={`border-b px-5 py-4 ${
              theme === 'dark' ? 'border-neutral-800' : 'border-stone-200'
            }`}>
              <Modal.Heading className="text-sm font-semibold">
                Pull request changelog
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="min-h-0 overflow-y-auto p-2">
              <ChangelogContent
                pullRequestNumber={pullRequestNumber}
                repositoryFullName={repositoryFullName}
                localContext={localContext}
                result={result}
              />
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function ChangelogContent({
  pullRequestNumber,
  repositoryFullName,
  localContext,
  result
}: {
  localContext?: PrototypeReviewLocalContext;
  pullRequestNumber?: number;
  repositoryFullName?: string;
  result?: PullRequestTestSurfacesResult;
}) {
  const identity = prototypeReviewChangelogIdentity({
    localContext,
    pullRequestNumber,
    repositoryFullName,
    result
  });
  if (!identity) {
    return (
      <section className="grid min-h-72 place-items-center px-6 text-center">
        <div className="max-w-sm">
          <FileClock className="mx-auto size-6 text-neutral-700" />
          <Text as="h2" className="mt-4 block text-sm font-medium text-neutral-200">
            Changelog is unavailable
          </Text>
          <Text className="mt-2 block text-xs leading-5 text-neutral-500">
            A verified repository, pull request, and head revision are required.
          </Text>
        </div>
      </section>
    );
  }
  return (
    <section className="px-3 py-3">
      <PullRequestChangelogSummary
        className="border-t-0"
        expectedIdentity={identity}
        snapshot={pullRequestChangelogSnapshotFor(identity)}
      />
    </section>
  );
}
