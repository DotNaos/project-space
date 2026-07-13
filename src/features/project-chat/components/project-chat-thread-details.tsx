import { ArrowLeft, ExternalLink, X } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import type {
  ProjectChatMemberRecord,
  ProjectChatMessageRecord
} from '@/shared/project-chat-api';
import {
  effectiveProjectChatPresence,
  formatProjectChatActivity,
  projectChatPresenceLabel,
  projectChatAgentNameIdentity,
  projectChatThreadParticipants,
  shortProjectChatId,
  type ProjectChatThreadSummary
} from '../project-chat-model';
import { ParticipantVisual, PresenceDot } from './participant-visual';
import type { CodexSessionTarget } from '../../codex-sessions/codex-session-route';

function DetailRow({
  label,
  value,
  valueClassName = 'truncate'
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex gap-4 border-t border-neutral-900 py-3 text-[10px]">
      <dt className="text-neutral-400">{label}</dt>
      <dd className={`ml-auto max-w-[65%] text-right text-neutral-400 ${valueClassName}`}>{value}</dd>
    </div>
  );
}

export function ProjectChatThreadDetails({
  members,
  messages,
  now,
  onBack,
  onClose,
  onOpenThread,
  thread
}: {
  members: ProjectChatMemberRecord[];
  messages: ProjectChatMessageRecord[];
  now: Date;
  onBack?(): void;
  onClose?(): void;
  onOpenThread?(target: CodexSessionTarget): void;
  thread?: ProjectChatThreadSummary;
}) {
  if (!thread) {
    return (
      <aside className="grid h-full min-h-0 place-items-center border-l border-neutral-800/80 bg-neutral-950/65 p-6 text-center">
        <div>
          <Text className="block text-sm font-medium text-neutral-300">Select a thread</Text>
          <Text className="mt-1 block text-xs leading-5 text-neutral-400">Origin and task details will appear here.</Text>
        </div>
      </aside>
    );
  }

  const member = members.find((entry) => (
    entry.memberId === thread.memberId && entry.role === 'agent'
  ));
  const presence = member ? effectiveProjectChatPresence(member, now) : 'offline';
  const participants = projectChatThreadParticipants(messages, members, thread);
  const threadMemberName = member?.displayName ?? thread.memberName;
  const memberAgentName = projectChatAgentNameIdentity(member);

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-neutral-800/80 bg-neutral-950/65">
      <div className="flex h-[68px] shrink-0 items-center border-b border-neutral-800/80 px-4">
        {onBack ? (
          <Button aria-label="Back to Project Chat activity" isIconOnly onPress={onBack} size="sm" variant="ghost" className="-ml-2 mr-1 size-8 min-h-0">
            <ArrowLeft className="size-4" />
          </Button>
        ) : null}
        <Text className="text-[10px] text-neutral-400">Thread</Text>
        <Text className="ml-auto font-mono text-[10px] text-neutral-400">{shortProjectChatId(thread.threadId)}</Text>
        {onClose ? (
          <Button aria-label="Close Project Chat details" isIconOnly onPress={onClose} size="sm" variant="ghost" className="-mr-2 ml-1 size-8 min-h-0">
            <X className="size-4" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="flex items-center gap-3">
          <ParticipantVisual
            active={presence === 'working'}
            agentCategory={memberAgentName?.category}
            agentName={memberAgentName?.name}
            role="agent"
            selected
            size={42}
          />
          <div className="min-w-0">
            <Text as="h2" className="truncate text-sm font-semibold text-neutral-100">{threadMemberName}</Text>
            <span className="mt-1 flex items-center gap-1.5 text-[9px] text-neutral-400">
              <PresenceDot state={presence} />
              {projectChatPresenceLabel(presence)}
            </span>
          </div>
        </div>

        <div className="mt-6">
          <Text className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-400">Current task</Text>
          <Text as="h3" className="mt-2 text-sm font-medium leading-5 text-neutral-200">{thread.taskTitle}</Text>
        </div>

        <dl className="mt-5">
          <DetailRow
            label="Source thread"
            value={thread.threadId}
            valueClassName="break-all font-mono text-[9px] leading-4"
          />
          <DetailRow label="Host" value={thread.hostId} />
          <DetailRow label="Machine" value={thread.machineId} />
          <DetailRow label="Last activity" value={formatProjectChatActivity(thread.lastActivityAt, now)} />
          <DetailRow label="Status" value={projectChatPresenceLabel(presence)} />
        </dl>

        <div className="border-t border-neutral-900 pt-4">
          <Text className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-400">Participants</Text>
          <div className="mt-3 space-y-2.5">
            {participants.map((participant) => {
              const agentName = projectChatAgentNameIdentity(participant);
              return (
              <div className="flex items-center gap-2.5" key={participant.memberId}>
                <ParticipantVisual
                  agentCategory={agentName?.category}
                  agentName={agentName?.name}
                  avatarUrl={participant.avatarUrl}
                  displayName={participant.displayName}
                  role={participant.role}
                  size={24}
                />
                <Text className="min-w-0 flex-1 truncate text-[10px] text-neutral-400">{participant.displayName}</Text>
                <Text className="text-[10px] capitalize text-neutral-400">{participant.role}</Text>
              </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-neutral-800/80 p-4">
        <Button
          fullWidth
          isDisabled={!onOpenThread}
          onPress={() => onOpenThread?.({
            machineId: thread.machineId,
            threadId: thread.threadId
          })}
          size="sm"
          variant="outline"
          className="rounded-full"
        >
          Open Codex thread
          <ExternalLink className="size-3" />
        </Button>
      </div>
    </aside>
  );
}
