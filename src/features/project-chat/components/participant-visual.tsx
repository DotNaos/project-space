import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import type { ProjectChatRole } from '@/shared/project-chat-api';
import { AgentOrb } from './agent-orb';

export function ParticipantVisual({
  active = false,
  avatarUrl,
  displayName,
  role,
  selected = false,
  size = 36
}: {
  active?: boolean;
  avatarUrl?: string;
  displayName?: string;
  role: ProjectChatRole;
  selected?: boolean;
  size?: number;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [avatarUrl]);

  if (role === 'agent') {
    return (
      <AgentOrb
        motion={active && selected ? 'ambient' : 'none'}
        phaseSeconds={size}
        size={size}
      />
    );
  }

  if (role === 'human') {
    const initials = participantInitials(displayName);
    return (
      <span
        aria-hidden="true"
        className="grid shrink-0 place-items-center overflow-hidden rounded-full border border-white/15 bg-neutral-100 text-neutral-950"
        style={{ height: size, width: size }}
      >
        {avatarUrl && !imageFailed ? (
          <img
            alt=""
            className="size-full object-cover"
            decoding="async"
            onError={() => setImageFailed(true)}
            referrerPolicy="no-referrer"
            src={avatarUrl}
          />
        ) : (
          <span className="text-[0.68em] font-semibold uppercase tracking-tight">{initials}</span>
        )}
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full border border-white/15 bg-neutral-100 text-neutral-950"
      style={{ height: size, width: size }}
    >
      <Radio size={Math.max(13, Math.round(size * 0.4))} strokeWidth={1.8} />
    </span>
  );
}

function participantInitials(displayName?: string) {
  const parts = displayName?.trim().split(/\s+/u).filter(Boolean) ?? [];
  const initials = parts.slice(0, 2).map((part) => part[0]).join('');
  return initials || '?';
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
