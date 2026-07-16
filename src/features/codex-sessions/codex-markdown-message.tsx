import { memo, type ComponentProps } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

function MarkdownLink({ children, className, href, node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) {
  const external = Boolean(href && /^(?:https?:)?\/\//i.test(href));
  return (
    <a
      {...props}
      className={cn(
        'font-medium text-neutral-100 underline decoration-neutral-600 underline-offset-4 transition-colors hover:decoration-neutral-300',
        className
      )}
      href={href}
      rel={external ? 'noreferrer noopener' : undefined}
      target={external ? '_blank' : undefined}
    >
      {children}
    </a>
  );
}

const markdownComponents: Components = {
  a: MarkdownLink,
  blockquote: ({ children, node: _node, ...props }) => (
    <blockquote {...props} className="my-4 border-l-2 border-neutral-700 pl-4 text-neutral-400">
      {children}
    </blockquote>
  ),
  code: ({ children, className, node: _node, ...props }) => (
    <code
      {...props}
      className={cn(
        'rounded-md bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[0.85em] text-neutral-100',
        className
      )}
    >
      {children}
    </code>
  ),
  h1: ({ children, node: _node, ...props }) => <h1 {...props} className="mb-2 mt-6 text-xl font-semibold tracking-tight text-neutral-50 first:mt-0">{children}</h1>,
  h2: ({ children, node: _node, ...props }) => <h2 {...props} className="mb-2 mt-6 text-lg font-semibold tracking-tight text-neutral-50 first:mt-0">{children}</h2>,
  h3: ({ children, node: _node, ...props }) => <h3 {...props} className="mb-2 mt-5 text-base font-semibold tracking-tight text-neutral-100 first:mt-0">{children}</h3>,
  h4: ({ children, node: _node, ...props }) => <h4 {...props} className="mb-2 mt-4 text-sm font-semibold text-neutral-100 first:mt-0">{children}</h4>,
  hr: ({ node: _node, ...props }) => <hr {...props} className="my-5 border-neutral-800" />,
  img: ({ alt, className, node: _node, ...props }) => (
    <img
      {...props}
      alt={alt ?? ''}
      className={cn('my-4 max-h-80 max-w-full rounded-2xl object-contain', className)}
      loading="lazy"
    />
  ),
  input: ({ className, node: _node, ...props }) => (
    <input {...props} className={cn('mr-2 accent-neutral-200', className)} disabled />
  ),
  li: ({ children, className, node: _node, ...props }) => (
    <li {...props} className={cn('pl-0.5 marker:text-neutral-600', className)}>{children}</li>
  ),
  ol: ({ children, node: _node, ...props }) => <ol {...props} className="my-3 ml-5 list-decimal space-y-1.5">{children}</ol>,
  p: ({ children, node: _node, ...props }) => <p {...props} className="my-0 [&+p]:mt-4">{children}</p>,
  pre: ({ children, node: _node, ...props }) => (
    <pre
      {...props}
      className="my-4 max-w-full overflow-x-auto rounded-2xl border border-neutral-800 bg-black/40 p-4 text-xs leading-5 text-neutral-200 [&_code]:bg-transparent [&_code]:p-0"
    >
      {children}
    </pre>
  ),
  table: ({ children, node: _node, ...props }) => (
    <div className="my-4 max-w-full overflow-x-auto rounded-xl border border-neutral-800">
      <table {...props} className="w-full min-w-max border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  td: ({ children, node: _node, ...props }) => <td {...props} className="border-t border-neutral-800 px-3 py-2 align-top">{children}</td>,
  th: ({ children, node: _node, ...props }) => <th {...props} className="bg-neutral-900/80 px-3 py-2 font-medium text-neutral-100">{children}</th>,
  ul: ({ children, className, node: _node, ...props }) => {
    const taskList = className?.includes('contains-task-list');
    return (
      <ul
        {...props}
        className={cn(
          'my-3 space-y-1.5',
          taskList ? 'ml-0 list-none' : 'ml-5 list-disc',
          className
        )}
      >
        {children}
      </ul>
    );
  }
};

export const CodexMarkdownMessage = memo(function CodexMarkdownMessage({
  className,
  text
}: {
  className?: string;
  text: string;
}) {
  return (
    <div className={cn('min-w-0 break-words text-[0.9375rem] leading-7 text-neutral-300', className)}>
      <Markdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {text}
      </Markdown>
    </div>
  );
});
