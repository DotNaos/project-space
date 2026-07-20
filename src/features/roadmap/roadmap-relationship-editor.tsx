import { useState } from 'react';
import { GitBranch, X } from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import type { GitHubIssueRecord } from '@/shared/project-space-api';
import type { RoadmapIssueNode } from '@/shared/roadmap-api';
import { RoadmapIssuePicker } from './roadmap-issue-picker';
import {
  roadmapPlannedSuccessorCandidates,
  roadmapRelationshipRequest,
  type RoadmapRelationshipDirection
} from './roadmap-relationship-model';
import type { RoadmapController } from './use-roadmap';

export type { RoadmapRelationshipDirection } from './roadmap-relationship-model';

export function RoadmapRelationshipEditor({
  direction,
  issue,
  issueError,
  issues,
  isLoadingIssues,
  onClose,
  roadmap
}: {
  direction: RoadmapRelationshipDirection;
  issue: RoadmapIssueNode;
  issueError?: string;
  issues: readonly GitHubIssueRecord[];
  isLoadingIssues?: boolean;
  onClose(): void;
  roadmap: RoadmapController;
}) {
  const result = roadmap.result;
  const [repository, setRepository] = useState(result?.repository.fullName ?? '');
  if (!result) return null;
  const selectedIsLocal = issue.issue.fullName.toLowerCase() === result.repository.fullName.toLowerCase();
  const successorCandidates = roadmapPlannedSuccessorCandidates(result);
  const relatedNumbers = new Set(result.dependencies.flatMap((edge) => {
    if (direction === 'prerequisite' && edge.blocked.id === issue.issue.id) {
      return edge.blocker.fullName.toLowerCase() === result.repository.fullName.toLowerCase()
        ? [edge.blocker.number]
        : [];
    }
    if (direction === 'successor' && edge.blocker.id === issue.issue.id) return [edge.blocked.number];
    return [];
  }));
  if (selectedIsLocal) relatedNumbers.add(issue.issue.number);
  const save = (issueNumber: number) => {
    const request = roadmapRelationshipRequest(direction, issue, issueNumber, repository);
    void roadmap.addDependency(request).then((saved) => { if (saved) onClose(); });
  };
  if (direction === 'prerequisite' && !selectedIsLocal) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/35 p-3">
        <Text className="text-xs text-neutral-400">
          External prerequisites are context only. Open their repository to edit what blocks them.
        </Text>
        <Button className="mt-2" onPress={onClose} size="sm" variant="ghost">Close</Button>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-neutral-700 bg-neutral-900/45 p-3">
      <div className="mb-3 flex items-center gap-2">
        <GitBranch className="size-3.5 text-neutral-400" />
        <Text className="text-xs font-semibold text-neutral-200">
          Add {direction === 'prerequisite' ? 'a prerequisite' : 'an issue this unlocks'}
        </Text>
        <Button aria-label="Close relationship editor" className="ml-auto" isIconOnly onPress={onClose} size="sm" variant="ghost">
          <X className="size-3.5" />
        </Button>
      </div>
      {direction === 'prerequisite' ? (
        <label className="mb-3 grid gap-1 text-[11px] text-neutral-400">
          Exact prerequisite repository
          <input
            className="min-h-10 rounded-lg border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:border-neutral-500"
            onChange={(event) => setRepository(event.target.value)}
            placeholder="owner/repository"
            value={repository}
          />
        </label>
      ) : null}
      <RoadmapIssuePicker
        error={issueError}
        excludedNumbers={relatedNumbers}
        isDisabled={!result.canEdit || result.dependencySync !== 'current' || roadmap.isSaving}
        isLoading={isLoadingIssues}
        issues={direction === 'successor'
          ? successorCandidates
          : repository.toLowerCase() !== result.repository.fullName.toLowerCase() ? [] : issues}
        onSelect={(candidate) => save(candidate.number)}
        onUseExactNumber={direction === 'prerequisite' ? save : undefined}
        title={direction === 'prerequisite'
          ? 'Search accessible issues or use an exact number'
          : 'Search planned successors'}
      />
    </div>
  );
}
