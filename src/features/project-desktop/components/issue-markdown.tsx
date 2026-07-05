import type { ReactNode } from 'react';

type MarkdownBlock =
  | { kind: 'code'; code: string; language?: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'hr' }
  | { kind: 'list'; ordered: boolean; items: MarkdownListItem[] }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'quote'; lines: string[] };

type MarkdownListItem = {
  checked?: boolean;
  text: string;
  task: boolean;
};

export function IssueMarkdown({ markdown }: { markdown?: string }) {
  const trimmedMarkdown = markdown?.trim();

  if (!trimmedMarkdown) {
    return (
      <div className="mt-5 text-sm leading-6 text-neutral-500">
        No issue description.
      </div>
    );
  }

  const blocks = parseMarkdown(trimmedMarkdown);

  return (
    <div className="mt-5 text-sm leading-6 text-neutral-300">
      <div className="grid gap-4">
        {blocks.map((block, index) => renderBlock(block, index))}
      </div>
    </div>
  );
}

function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraphLines: string[] = [];
  let activeList: MarkdownBlock | undefined;
  let activeQuote: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      blocks.push({ kind: 'paragraph', lines: paragraphLines });
      paragraphLines = [];
    }
  };

  const flushList = () => {
    if (activeList) {
      blocks.push(activeList);
      activeList = undefined;
    }
  };

  const flushQuote = () => {
    if (activeQuote.length > 0) {
      blocks.push({ kind: 'quote', lines: activeQuote });
      activeQuote = [];
    }
  };

  const flushTextBlocks = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^```([A-Za-z0-9_-]+)?\s*$/);

    if (fenceMatch) {
      flushTextBlocks();

      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !lines[index].match(/^```\s*$/)) {
        codeLines.push(lines[index]);
        index += 1;
      }

      blocks.push({ kind: 'code', code: codeLines.join('\n'), language: fenceMatch[1] });
      continue;
    }

    if (!line.trim()) {
      flushTextBlocks();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      flushTextBlocks();
      blocks.push({
        kind: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim()
      });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushTextBlocks();
      blocks.push({ kind: 'hr' });
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);

    if (quoteMatch) {
      flushParagraph();
      flushList();
      activeQuote.push(quoteMatch[1]);
      continue;
    }

    const unorderedMatch = line.match(/^\s*[-*]\s+(.+)$/);
    const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    const listText = unorderedMatch?.[1] ?? orderedMatch?.[1];

    if (listText) {
      flushParagraph();
      flushQuote();

      const ordered = Boolean(orderedMatch);
      const taskMatch = listText.match(/^\[( |x|X)\]\s+(.+)$/);
      const item: MarkdownListItem = taskMatch
        ? { checked: taskMatch[1].toLowerCase() === 'x', task: true, text: taskMatch[2] }
        : { task: false, text: listText };

      if (!activeList || activeList.kind !== 'list' || activeList.ordered !== ordered) {
        flushList();
        activeList = { kind: 'list', items: [], ordered };
      }

      activeList.items.push(item);
      continue;
    }

    flushList();
    flushQuote();
    paragraphLines.push(line);
  }

  flushTextBlocks();

  return blocks;
}

function renderBlock(block: MarkdownBlock, index: number) {
  switch (block.kind) {
    case 'code':
      return (
        <pre
          key={index}
          className="overflow-auto rounded-md border border-neutral-800 bg-neutral-950 p-3 text-xs leading-5 text-neutral-200"
        >
          {block.language ? (
            <div className="mb-2 text-[0.68rem] uppercase tracking-[0.16em] text-neutral-600">
              {block.language}
            </div>
          ) : null}
          <code>{block.code}</code>
        </pre>
      );
    case 'heading': {
      const headingClass =
        block.level <= 2
          ? 'text-base font-semibold text-neutral-100'
          : 'text-sm font-semibold text-neutral-100';

      return renderHeading(block.level, headingClass, renderInline(block.text), index);
    }
    case 'hr':
      return <div key={index} className="h-px bg-neutral-800" />;
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';

      return (
        <ListTag
          key={index}
          className={[
            'ml-5 grid gap-1 text-neutral-300',
            block.ordered ? 'list-decimal' : 'list-disc'
          ].join(' ')}
        >
          {block.items.map((item, itemIndex) => (
            <li key={`${index}-${itemIndex}`} className={item.task ? 'list-none' : undefined}>
              {item.task ? (
                <label className="-ml-5 flex items-start gap-2">
                  <input
                    checked={item.checked}
                    readOnly
                    type="checkbox"
                    className="mt-1 size-3.5 rounded border-neutral-700 bg-neutral-950"
                  />
                  <span>{renderInline(item.text)}</span>
                </label>
              ) : (
                renderInline(item.text)
              )}
            </li>
          ))}
        </ListTag>
      );
    }
    case 'paragraph':
      return (
        <p key={index} className="whitespace-pre-wrap text-neutral-300">
          {renderInline(block.lines.join('\n'))}
        </p>
      );
    case 'quote':
      return (
        <blockquote
          key={index}
          className="border-l-2 border-neutral-700 pl-3 text-neutral-400"
        >
          {renderInline(block.lines.join('\n'))}
        </blockquote>
      );
  }
}

function renderHeading(level: number, className: string, children: ReactNode[], key: number) {
  if (level === 1) {
    return (
      <h1 key={key} className={className}>
        {children}
      </h1>
    );
  }

  if (level === 2) {
    return (
      <h2 key={key} className={className}>
        {children}
      </h2>
    );
  }

  if (level === 3) {
    return (
      <h3 key={key} className={className}>
        {children}
      </h3>
    );
  }

  if (level === 4) {
    return (
      <h4 key={key} className={className}>
        {children}
      </h4>
    );
  }

  if (level === 5) {
    return (
      <h5 key={key} className={className}>
        {children}
      </h5>
    );
  }

  return (
    <h6 key={key} className={className}>
      {children}
    </h6>
  );
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text))) {
    appendText(nodes, text.slice(lastIndex, match.index));

    const token = match[0];
    const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);

    if (token.startsWith('`')) {
      nodes.push(
        <code
          key={`code-${match.index}`}
          className="rounded bg-neutral-900 px-1 py-0.5 font-mono text-[0.85em] text-neutral-100"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (linkMatch) {
      const href = safeHref(linkMatch[2]);

      nodes.push(
        href ? (
          <a
            key={`link-${match.index}`}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-blue-300 underline decoration-blue-300/40 underline-offset-2 transition hover:text-blue-200"
          >
            {linkMatch[1]}
          </a>
        ) : (
          <span key={`link-${match.index}`}>{linkMatch[1]}</span>
        )
      );
    }

    lastIndex = match.index + token.length;
  }

  appendText(nodes, text.slice(lastIndex));

  return nodes;
}

function appendText(nodes: ReactNode[], text: string) {
  if (!text) {
    return;
  }

  const parts = text.split('\n');

  parts.forEach((part, index) => {
    if (index > 0) {
      nodes.push(<br key={`break-${nodes.length}`} />);
    }

    if (part) {
      nodes.push(part);
    }
  });
}

function safeHref(href: string) {
  const trimmedHref = href.trim();

  if (/^(https?:|mailto:)/i.test(trimmedHref)) {
    return trimmedHref;
  }

  return undefined;
}
