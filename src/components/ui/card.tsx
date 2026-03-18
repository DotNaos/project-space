import type { HTMLAttributes, PropsWithChildren } from 'react';

import { cn } from '@/lib/utils';

export function Card({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div
      className={cn('rounded-xl border border-slate-800 bg-slate-950/90', className)}
      {...props}
    >
      {children}
    </div>
  );
}
