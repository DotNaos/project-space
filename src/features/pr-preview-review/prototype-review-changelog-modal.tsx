import { Modal } from '@heroui/react';
import { FileClock } from 'lucide-react';

import { Text } from '@/app/dotnaos-ui';
import { PullRequestChangelogSummary } from '@/features/pr-preview-changelog/pull-request-changelog-summary';
import type {
  PullRequestChangelogIdentity,
  PullRequestChangelogSnapshot
} from '@/shared/pr-preview-changelog-api';
import { pullRequestChangelogSchema } from '@/shared/pr-preview-changelog-api';
import type { PullRequestTestSurfacesResult } from '@/shared/pr-preview-test-surfaces-api';
import type { PrototypeTheme } from '@/shared/prototype-canvas';
import type { PrototypeReviewLocalContext } from '@/shared/prototype-review-local-api';
import { prototypeReviewChangelogIdentity } from './prototype-review-changelog';

interface PrototypeReviewChangelogModalProps {
  expectedIdentity?: PullRequestChangelogIdentity;
  isOpen: boolean;
  localContext?: PrototypeReviewLocalContext;
  onOpenChange(open: boolean): void;
  previewBuildIdentity?: PullRequestChangelogIdentity;
  prototypeTarget?: string;
  pullRequestNumber?: number;
  repositoryFullName?: string;
  result?: PullRequestTestSurfacesResult;
  selectedChangeId?: string;
  snapshot?: PullRequestChangelogSnapshot;
  theme: PrototypeTheme;
}

export function PrototypeReviewChangelogModal({
  expectedIdentity,
  isOpen,
  localContext,
  onOpenChange,
  previewBuildIdentity,
  prototypeTarget,
  pullRequestNumber,
  repositoryFullName,
  result,
  selectedChangeId,
  snapshot,
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
                expectedIdentity={expectedIdentity}
                localContext={localContext}
                previewBuildIdentity={previewBuildIdentity}
                prototypeTarget={prototypeTarget}
                pullRequestNumber={pullRequestNumber}
                repositoryFullName={repositoryFullName}
                result={result}
                selectedChangeId={selectedChangeId}
                snapshot={snapshot}
              />
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function ChangelogContent({
  expectedIdentity,
  localContext,
  previewBuildIdentity,
  prototypeTarget,
  pullRequestNumber,
  repositoryFullName,
  result,
  selectedChangeId,
  snapshot
}: {
  expectedIdentity?: PullRequestChangelogIdentity;
  localContext?: PrototypeReviewLocalContext;
  previewBuildIdentity?: PullRequestChangelogIdentity;
  prototypeTarget?: string;
  pullRequestNumber?: number;
  repositoryFullName?: string;
  result?: PullRequestTestSurfacesResult;
  selectedChangeId?: string;
  snapshot?: PullRequestChangelogSnapshot;
}) {
  const identity = prototypeReviewChangelogIdentity({
    expectedIdentity,
    localContext,
    previewBuildIdentity,
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
        prototypeTarget={prototypeTarget}
        selectedChangeId={selectedChangeId}
        snapshot={snapshot ?? {
          ...identity,
          entries: [],
          reasonCode: 'source-unavailable',
          schema: pullRequestChangelogSchema,
          state: 'invalid'
        }}
      />
    </section>
  );
}
