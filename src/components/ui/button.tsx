import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

import { cn } from '@/lib/utils';

type ButtonVariant = 'default' | 'outline' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variantClasses: Record<ButtonVariant, string> = {
  default:
    'bg-slate-100 text-slate-950 hover:bg-white disabled:bg-slate-900 disabled:text-slate-500',
  outline:
    'border border-slate-700 bg-slate-900 text-slate-100 hover:border-slate-600 hover:bg-slate-800 disabled:text-slate-500',
  ghost:
    'bg-transparent text-slate-400 hover:bg-slate-900 hover:text-slate-100 disabled:text-slate-500'
};

export function Button({
  children,
  className,
  variant = 'default',
  ...props
}: PropsWithChildren<ButtonProps>) {
  return (
    <button
      className={cn(
        'inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-slate-500 disabled:pointer-events-none',
        variantClasses[variant],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
