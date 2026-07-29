import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type TextareaHTMLAttributes
} from 'react';
import { cn } from '@/lib/utils';

export const CodexComposerTextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function CodexComposerTextArea({ className, onChange, rows = 1, value, ...props }, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => textareaRef.current!, []);
  useLayoutEffect(() => resizeComposer(textareaRef.current), [value]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      rows={rows}
      value={value}
      onChange={(event) => {
        resizeComposer(event.currentTarget);
        onChange?.(event);
      }}
      className={cn(
        'max-h-36 min-h-10 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-2.5 py-2 text-base leading-6 text-neutral-100 outline-none placeholder:text-neutral-600 disabled:cursor-not-allowed disabled:text-neutral-600 sm:text-sm',
        !value && '!overflow-y-hidden',
        className
      )}
    />
  );
});

function resizeComposer(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  if (!textarea.value) {
    textarea.style.height = '';
    return;
  }
  textarea.style.height = '0px';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
}
