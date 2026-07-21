import { useEffect, useState } from 'react';
import { Check, CircleHelp, ShieldAlert, X } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import { CodexComposerTextArea } from './codex-composer-textarea';
import { codexThreadOrigin } from './codex-sessions-model';
import type {
  CodexApprovalDecision,
  CodexConversation,
  CodexSession,
  CodexUserInputDecision
} from './codex-sessions-types';

export function CodexDecisionPanel({
  conversation,
  onResolveApproval,
  onResolveUserInput,
  session
}: {
  conversation?: CodexConversation;
  onResolveApproval?(decision: CodexApprovalDecision): Promise<void> | void;
  onResolveUserInput?(decision: CodexUserInputDecision): Promise<void> | void;
  session: CodexSession;
}) {
  const [selectedChoices, setSelectedChoices] = useState<Record<string, string>>({});
  const requestsKey = conversation?.userInputRequests
    ?.map((request) => `${request.id}:${request.questions.map((question) => question.id).join(',')}`)
    .join('|') ?? '';

  useEffect(() => setSelectedChoices({}), [requestsKey, session.threadId]);

  const approvals = conversation?.approvals ?? [];
  const inputRequests = conversation?.userInputRequests ?? [];
  if (approvals.length === 0 && inputRequests.length === 0) return null;
  const origin = codexThreadOrigin(session);

  return (
    <section
      aria-label="Codex needs your decision"
      className="mx-auto mb-2 max-h-72 w-[calc(100%-1.5rem)] max-w-[84ch] shrink-0 overflow-y-auto rounded-xl border border-amber-400/20 bg-amber-400/[0.04] px-3 py-3 sm:w-[calc(100%-3rem)]"
    >
      {approvals.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-amber-200">
            <ShieldAlert className="size-3.5" />
            <Text className="text-[10px] font-semibold uppercase tracking-[0.14em]">
              Waiting for approval
            </Text>
          </div>
          {approvals.map((request) => (
            <div className="border-t border-amber-300/10 pt-3 first:border-t-0 first:pt-0" key={request.id}>
              <Text className="block text-xs font-medium text-neutral-100">{request.title}</Text>
              <Text className="mt-1 block text-[10px] leading-4 text-neutral-400">
                {request.description}
              </Text>
              <div className="mt-2 flex gap-2">
                <Button
                  isDisabled={!onResolveApproval || !request.canAllow}
                  onPress={() => void onResolveApproval?.({
                    ...origin,
                    decision: 'allow_once',
                    requestId: request.id
                  })}
                  size="sm"
                  variant="outline"
                >
                  <Check className="size-3" /> Allow once
                </Button>
                <Button
                  isDisabled={!onResolveApproval}
                  onPress={() => void onResolveApproval?.({
                    ...origin,
                    decision: 'deny',
                    requestId: request.id
                  })}
                  size="sm"
                  variant="ghost"
                >
                  <X className="size-3" /> Deny
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {inputRequests.map((request) => (
        <fieldset className="mt-3 border-t border-amber-300/10 pt-3 first:mt-0 first:border-t-0 first:pt-0" key={request.id}>
          <legend className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-200">
            <CircleHelp className="size-3.5" /> Waiting for input
          </legend>
          <Text className="mt-2 block text-xs font-medium text-neutral-100">{request.title}</Text>
          {request.questions.map((question) => {
            const choiceKey = `${request.id}:${question.id}`;
            return (
              <div className="mt-3" key={question.id}>
                <Text className="block text-xs leading-5 text-neutral-200">{question.prompt}</Text>
                {question.choices.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {question.choices.map((choice) => (
                      <label
                        className="flex min-w-32 cursor-pointer items-start gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-[10px] text-neutral-300 has-[:checked]:border-neutral-300 has-[:checked]:bg-neutral-100 has-[:checked]:text-neutral-950"
                        key={choice.value}
                      >
                        <input
                          checked={selectedChoices[choiceKey] === choice.value}
                          className="sr-only"
                          name={`codex-request-${choiceKey}`}
                          onChange={() => setSelectedChoices((current) => ({
                            ...current,
                            [choiceKey]: choice.value
                          }))}
                          type="radio"
                          value={choice.value}
                        />
                        <span className="min-w-0">
                          <Text className="block text-[10px] font-medium">{choice.value}</Text>
                          {choice.description ? (
                            <Text className="mt-0.5 block text-[9px] leading-4 opacity-70">
                              {choice.description}
                            </Text>
                          ) : null}
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <CodexComposerTextArea
                    aria-label={`Response to ${question.prompt}`}
                    className="mt-2 w-full rounded-lg border border-neutral-700 bg-neutral-950/70 px-3"
                    onChange={(event) => setSelectedChoices((current) => ({
                      ...current,
                      [choiceKey]: event.target.value
                    }))}
                    placeholder="Enter your response"
                    rows={2}
                    value={selectedChoices[choiceKey] ?? ''}
                  />
                )}
              </div>
            );
          })}
          <Button
            className="mt-3"
            isDisabled={!onResolveUserInput || request.questions.some(
              (question) => !selectedChoices[`${request.id}:${question.id}`]?.trim()
            )}
            onPress={() => void onResolveUserInput?.({
              ...origin,
              answers: request.questions.map((question) => ({
                questionId: question.id,
                value: selectedChoices[`${request.id}:${question.id}`]!.trim()
              })),
              requestId: request.id
            })}
            size="sm"
            variant="outline"
          >
            Submit response
          </Button>
        </fieldset>
      ))}
    </section>
  );
}
