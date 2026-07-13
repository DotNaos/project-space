import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const CodexComposerTextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function CodexComposerTextArea({ className, rows = 1, ...props }, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      rows={rows}
      className={cn(
        'max-h-36 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 disabled:cursor-not-allowed disabled:text-neutral-600',
        className
      )}
    />
  );
});

