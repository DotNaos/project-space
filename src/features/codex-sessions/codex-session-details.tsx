import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Circle,
  ExternalLink,
  ShieldAlert,
  WifiOff,
  X
} from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import {
  codexThreadOrigin,
  effectiveCodexSessionStatus,
  formatCodexActivity
} from './codex-sessions-model';
import { CodexComposerTextArea } from './codex-composer-textarea';
import type {
  CodexApprovalDecision,
  CodexConversation,
  CodexMachine,
  CodexSession,
  CodexThreadOrigin,
  CodexUserInputDecision
} from './codex-sessions-types';

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-4 border-t border-neutral-900 py-3 text-[10px]">
      <dt className="shrink-0 text-neutral-500">{label}</dt>
      <dd className={cn(
        'ml-auto min-w-0 max-w-[70%] break-words text-right text-neutral-400',
        mono && 'font-mono text-[9px] leading-4'
      )}>{value}</dd>
    </div>
  );
}

export function CodexSessionDetails({
  activeTurnId,
  conversation,
  machine,
  now,
  onBack,
  onInterruptThread,
  onOpenProjectChatThread,
  onResolveApproval,
  onResolveUserInput,
  session
}: {
  activeTurnId?: string;
  conversation?: CodexConversation;
  machine?: CodexMachine;
  now: Date;
  onBack?(): void;
  onInterruptThread?(origin: CodexThreadOrigin, turnId: string): Promise<void> | void;
  onOpenProjectChatThread?(origin: CodexThreadOrigin): void;
  onResolveApproval?(decision: CodexApprovalDecision): Promise<void> | void;
  onResolveUserInput?(decision: CodexUserInputDecision): Promise<void> | void;
  session?: CodexSession;
}) {
  const [selectedChoices, setSelectedChoices] = useState<Record<string, string>>({});
  const inputRequestKey = conversation?.userInputRequests
    ?.map((request) => `${request.id}:${request.questions.map((question) => question.id).join(',')}`)
    .join('|') ?? '';

  useEffect(() => setSelectedChoices({}), [session?.threadId, inputRequestKey]);

  if (!session) {
    return (
      <aside className="grid h-full min-h-0 place-items-center border-l border-neutral-800/80 bg-neutral-950/80 p-6 text-center">
        <Text className="text-xs text-neutral-500">Session details and human decisions appear here.</Text>
      </aside>
    );
  }

  const origin = codexThreadOrigin(session);
  const status = effectiveCodexSessionStatus(session, machine);
  const unavailable = status === 'offline' || status === 'missing' || status === 'unavailable';

  return (
    <aside aria-label="Codex session details" className="flex h-full min-h-0 flex-col border-l border-neutral-800/80 bg-neutral-950/80">
      <header className="flex h-[68px] shrink-0 items-center border-b border-neutral-800/80 px-4">
        {onBack ? (
          <Button aria-label="Back to conversation" className="-ml-2 mr-1 size-8 min-h-0" isIconOnly onPress={onBack} size="sm" variant="ghost">
            <ArrowLeft className="size-4" />
          </Button>
        ) : null}
        <Text className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500">Session</Text>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[9px] capitalize text-neutral-400">
          <Circle className={cn(
            'size-1.5 fill-current',
            status === 'active' ? 'text-emerald-400' : unavailable ? 'text-amber-400' : 'text-neutral-500'
          )} />
          {status}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <Text as="h2" className="block text-sm font-semibold leading-5 text-neutral-100">{session.title}</Text>
        <Text className="mt-1 block text-[10px] text-neutral-500">Owned by {machine?.name ?? session.machineId}</Text>

        {unavailable ? (
          <div className="mt-4 flex gap-2 border-y border-amber-500/20 bg-amber-500/5 px-3 py-3 text-[10px] leading-4 text-amber-200/80">
            {status === 'offline' ? <WifiOff className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
            <Text>{session.statusDetail ?? machine?.statusDetail ?? (
              status === 'missing'
                ? 'This thread was listed previously but is no longer stored on the owning machine.'
                : 'History remains visible when cached, but Project Space will not send work while the machine is unavailable.'
            )}</Text>
          </div>
        ) : null}

        <dl className="mt-5">
          <DetailRow label="Machine" value={machine?.name ?? session.machineId} />
          <DetailRow label="Machine ID" mono value={session.machineId} />
          <DetailRow label="Thread ID" mono value={session.threadId} />
          <DetailRow label="Project" value={session.projectName ?? 'Not reported'} />
          <DetailRow label="Directory" mono value={session.cwd ?? 'Not reported'} />
          <DetailRow label="Model" value={session.model ?? 'Not reported'} />
          <DetailRow label="Last activity" value={formatCodexActivity(session.lastActivityAt, now)} />
          <DetailRow label="Storage" value={session.loadedByProjectSpace ? 'Loaded by Project Space' : session.stored ? 'Stored' : 'Unavailable'} />
        </dl>

        {(conversation?.approvals?.length ?? 0) > 0 ? (
          <section className="mt-5" aria-label="Permission requests">
            <div className="flex items-center gap-2 text-amber-300">
              <ShieldAlert className="size-3.5" />
              <Text className="text-[10px] font-semibold uppercase tracking-[0.14em]">Permission required</Text>
            </div>
            <div className="mt-3 space-y-3">
              {conversation?.approvals?.map((request) => (
                <div className="border-y border-neutral-800 py-3" key={request.id}>
                  <Text className="block text-xs font-medium text-neutral-200">{request.title}</Text>
                  <Text className="mt-1 block text-[10px] leading-4 text-neutral-500">{request.description}</Text>
                  <div className="mt-3 flex gap-2">
                    <Button
                      isDisabled={!onResolveApproval}
                      onPress={() => void onResolveApproval?.({ ...origin, decision: 'allow_once', requestId: request.id })}
                      size="sm"
                      variant="outline"
                    ><Check className="size-3" />Allow once</Button>
                    <Button
                      isDisabled={!onResolveApproval}
                      onPress={() => void onResolveApproval?.({ ...origin, decision: 'deny', requestId: request.id })}
                      size="sm"
                      variant="ghost"
                    ><X className="size-3" />Deny</Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {(conversation?.userInputRequests?.length ?? 0) > 0 ? (
          <section className="mt-6" aria-label="Codex questions">
            <Text className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-400">Input required</Text>
            <div className="mt-3 space-y-4">
              {conversation?.userInputRequests?.map((request) => (
                <fieldset className="border-y border-neutral-800 py-3" key={request.id}>
                  <legend className="text-xs font-medium text-neutral-200">{request.title}</legend>
                  {request.questions.map((question) => {
                    const choiceKey = `${request.id}:${question.id}`;
                    return (
                      <div className="mt-3" key={question.id}>
                        <Text className="block text-[10px] leading-4 text-neutral-500">{question.prompt}</Text>
                        {question.choices.length > 0 ? (
                          <div className="mt-2 space-y-1.5">
                            {question.choices.map((choice) => (
                            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-neutral-800 px-3 py-2.5 hover:border-neutral-700" key={choice.value}>
                              <input
                                checked={selectedChoices[choiceKey] === choice.value}
                                className="mt-0.5 accent-neutral-100"
                                name={`codex-request-${choiceKey}`}
                                onChange={() => setSelectedChoices((current) => ({ ...current, [choiceKey]: choice.value }))}
                                type="radio"
                                value={choice.value}
                              />
                              <span className="min-w-0">
                                <Text className="block text-[10px] text-neutral-300">{choice.value}</Text>
                                {choice.description ? <Text className="mt-0.5 block text-[9px] leading-4 text-neutral-600">{choice.description}</Text> : null}
                              </span>
                            </label>
                            ))}
                          </div>
                        ) : (
                          <CodexComposerTextArea
                            aria-label={`Response to ${question.prompt}`}
                            className="mt-2 w-full rounded-lg border border-neutral-800 bg-neutral-900/70 px-3"
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
                    isDisabled={
                      !onResolveUserInput
                      || request.questions.some((question) => !selectedChoices[`${request.id}:${question.id}`]?.trim())
                    }
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
                  >Submit response</Button>
                </fieldset>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-neutral-800/80 p-4">
        {status === 'active' && activeTurnId ? (
          <Button
            className="mb-2 rounded-full"
            fullWidth
            isDisabled={!onInterruptThread}
            onPress={() => void onInterruptThread?.(origin, activeTurnId)}
            size="sm"
            variant="danger"
          >Interrupt active turn</Button>
        ) : null}
        <Button
          fullWidth
          isDisabled={!onOpenProjectChatThread}
          onPress={() => onOpenProjectChatThread?.(origin)}
          size="sm"
          variant="outline"
          className="rounded-full"
        >
          Open Project Chat origin
          <ExternalLink className="size-3" />
        </Button>
      </div>
    </aside>
  );
}
