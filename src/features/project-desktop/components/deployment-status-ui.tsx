import type { ReactNode } from 'react';
import { CheckCircle2, CircleDashed, CircleSlash2, LoaderCircle, TriangleAlert, XCircle } from 'lucide-react';
import { Chip } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { StatusTone } from './deployment-status-model';

const toneClass: Record<StatusTone, string> = {
  danger: 'border-rose-400/30 bg-rose-400/10 text-rose-200',
  muted: 'border-neutral-700 bg-neutral-900 text-neutral-400',
  success: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  warning: 'border-amber-400/30 bg-amber-400/10 text-amber-200'
};

export function StatusChip({ children, tone }: { children: ReactNode; tone: StatusTone }) {
  return <Chip size="sm" className={cn('border', toneClass[tone])}>{children}</Chip>;
}

export function StatusIcon({ active = false, tone }: { active?: boolean; tone: StatusTone }) {
  const className = cn(
    'size-4 shrink-0',
    active && 'animate-spin',
    tone === 'warning' && 'text-amber-300',
    tone === 'success' && 'text-emerald-300',
    tone === 'muted' && 'text-neutral-500',
    tone === 'danger' && 'text-rose-300'
  );
  if (active) return <LoaderCircle className={className} />;
  if (tone === 'success') return <CheckCircle2 className={className} />;
  if (tone === 'danger') return <XCircle className={className} />;
  if (tone === 'warning') return <TriangleAlert className={className} />;
  return tone === 'muted' ? <CircleDashed className={className} /> : <CircleSlash2 className={className} />;
}
