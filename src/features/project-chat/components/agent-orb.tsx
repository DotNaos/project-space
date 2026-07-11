import type { CSSProperties } from 'react';
import './agent-orb.css';

type AgentOrbStyle = CSSProperties & {
  '--agent-orb-delay': string;
  '--agent-orb-size': string;
};

export interface AgentOrbProps {
  className?: string;
  motion?: 'ambient' | 'none';
  phaseSeconds?: number;
  size?: number;
}

export function AgentOrb({
  className = '',
  motion = 'none',
  phaseSeconds = 0,
  size = 36
}: AgentOrbProps) {
  const style: AgentOrbStyle = {
    '--agent-orb-delay': `${-Math.abs(phaseSeconds)}s`,
    '--agent-orb-size': `${size}px`
  };

  return (
    <span
      aria-hidden="true"
      className={`project-chat-agent-orb ${className}`.trim()}
      data-motion={motion}
      style={style}
    />
  );
}
