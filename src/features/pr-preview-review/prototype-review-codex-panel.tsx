import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Bot, CircleAlert, ShieldCheck } from 'lucide-react';

import {
  getProjectSpaceAuthToken,
  projectSpaceClient
} from '@/api/project-space-client';
import { createCodexSessionsClient } from '@/api/codex-sessions-client';
import { Text } from '@/app/dotnaos-ui';
import { CodexConversationPane } from '@/features/codex-sessions/codex-conversation-pane';
import { CodexSessionsController } from '@/features/codex-sessions/codex-sessions-controller';
import type { PullRequestTestSurfacesResult } from '@/shared/pr-preview-test-surfaces-api';
import type {
  PrototypeScenarioKind,
  PrototypeViewportKind
} from '@/shared/prototype-canvas';
import type { PrototypeReviewTarget } from './prototype-review-model';
import { feedbackMatchesTarget } from './prototype-review-model';

const feedbackReasonLabels = {
  'feedback-not-live': 'Codex feedback is available only from a verified live Dev Server.',
  'feedback-task-mismatch': 'The live server is linked to a different Codex task.',
  'feedback-task-missing': 'No Codex task is registered for this live server.',
  'feedback-task-unavailable': 'The linked Codex task is not reachable right now.',
  'feedback-write-capability-expired': 'The verified write permission expired. Refresh the live server.'
} as const;

export function PrototypeReviewCodexPanel({
  pullRequestNumber,
  repositoryFullName,
  result,
  scenario,
  target,
  viewport
}: {
  pullRequestNumber: number;
  repositoryFullName: string;
  result?: PullRequestTestSurfacesResult;
  scenario: PrototypeScenarioKind;
  target?: PrototypeReviewTarget;
  viewport: PrototypeViewportKind;
}) {
  const eligible = feedbackMatchesTarget(result, target);
  const connectorId = result?.liveContext.state === 'available'
    ? result.liveContext.connectorId
    : undefined;
  const threadId = result?.feedback.state === 'available'
    ? result.feedback.threadId
    : undefined;
  const origin = connectorId && threadId ? { machineId: connectorId, threadId } : undefined;
  const controller = useMemo(() => new CodexSessionsController(
    createCodexSessionsClient({ getAuthToken: getProjectSpaceAuthToken })
  ), []);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  );
  const [feedbackError, setFeedbackError] = useState<string>();
  const originKey = origin ? `${origin.machineId}\u0000${origin.threadId}` : '';

  useEffect(() => {
    if (!eligible || !origin) {
      controller.clearSelection();
      return;
    }
    void controller.loadMachines([origin.machineId]).then(() => controller.select(origin));
  }, [controller, eligible, originKey]);

  useEffect(() => () => controller.dispose(), [controller]);

  if (!eligible || !origin || !target) {
    const reason = result?.feedback.state !== 'available'
      ? feedbackReasonLabels[result?.feedback.reasonCode ?? 'feedback-not-live']
      : 'The selected prototype is not the verified live surface for this task.';
    return (
      <section className="grid h-full place-items-center bg-neutral-950 px-6 text-center">
        <div className="max-w-sm">
          <Bot className="mx-auto size-6 text-neutral-700" />
          <Text as="h2" className="mt-4 block text-sm font-medium text-neutral-200">
            Codex chat is unavailable
          </Text>
          <Text className="mt-2 block text-xs leading-5 text-neutral-500">{reason}</Text>
          <Text className="mt-4 block text-[10px] leading-4 text-neutral-600">
            Deployed PR prototypes stay read-only. Start and verify the scoped Dev Server on the
            owning machine to continue its exact Codex task.
          </Text>
        </div>
      </section>
    );
  }

  const session = state.sessions.find((candidate) =>
    candidate.machineId === origin.machineId && candidate.threadId === origin.threadId
  );
  const machine = state.machines.find((candidate) => candidate.id === origin.machineId);
  const conversation = state.conversations.find((candidate) =>
    candidate.machineId === origin.machineId && candidate.threadId === origin.threadId
  );
  const readBlocked = !state.reading && Boolean(state.errorMessage) && !conversation;
  const machineLabel = result?.liveContext.state === 'available'
    ? `${result.liveContext.machineId} · live`
    : origin.machineId;

  return (
    <section className="flex h-full min-h-0 flex-col bg-neutral-950">
      <header className="flex shrink-0 items-center gap-2 px-5 py-3">
        <ShieldCheck className="size-4 text-emerald-400" />
        <div className="min-w-0">
          <Text className="block truncate text-xs font-medium text-neutral-100">
            {session?.title ?? 'Verified PR task'}
          </Text>
          <Text className="mt-0.5 block truncate text-[10px] text-neutral-500">
            {machineLabel}
          </Text>
        </div>
      </header>
      {feedbackError ? (
        <div className="mx-4 mb-2 flex items-start gap-2 rounded-xl bg-rose-400/10 px-3 py-2 text-[10px] leading-4 text-rose-200">
          <CircleAlert className="mt-0.5 size-3 shrink-0" />
          {feedbackError}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <CodexConversationPane
          conversation={conversation}
          historyState={state.reading ? 'loading' : readBlocked ? 'blocked' : 'ready'}
          historyStatusDetail={state.errorMessage}
          machine={machine}
          onContinue={async (_origin, comment) => {
            setFeedbackError(undefined);
            try {
              await projectSpaceClient.sendPullRequestPrototypeFeedback({
                comment,
                pullRequestNumber,
                repositoryFullName,
                scenario,
                surface: target.surfaceKind,
                viewport
              });
              await controller.select(origin);
            } catch (error) {
              setFeedbackError(
                error instanceof Error ? error.message : 'Could not send prototype feedback.'
              );
            }
          }}
          session={session}
          showHeader={false}
        />
      </div>
    </section>
  );
}
