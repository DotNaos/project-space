import { Orbit, Radio } from 'lucide-react';
import type { ProjectChatRole } from '@/shared/project-chat-api';
import { AgentOrb } from './agent-orb';

export function ParticipantVisual({
  active = false,
  role,
  selected = false,
  size = 36
}: {
  active?: boolean;
  role: ProjectChatRole;
  selected?: boolean;
  size?: number;
}) {
  if (role === 'agent') {
    return (
      <AgentOrb
        motion={active && selected ? 'ambient' : 'none'}
        phaseSeconds={size}
        size={size}
      />
    );
  }

  const Icon = role === 'human' ? Orbit : Radio;
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full border border-white/15 bg-neutral-100 text-neutral-950"
      style={{ height: size, width: size }}
    >
      <Icon size={Math.max(13, Math.round(size * 0.4))} strokeWidth={1.8} />
    </span>
  );
}

export function PresenceDot({ state }: { state: 'idle' | 'offline' | 'working' }) {
  return (
    <span
      aria-label={state === 'working' ? 'Active' : state === 'idle' ? 'Idle' : 'Offline'}
      className={
        state === 'working'
          ? 'size-1.5 rounded-full bg-emerald-400'
          : state === 'idle'
            ? 'size-1.5 rounded-full bg-neutral-500'
            : 'size-1.5 rounded-full border border-neutral-600 bg-transparent'
      }
      role="img"
    />
  );
}
