function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInlineMarkdown(value: string) {
  return escapeHtml(value)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer" class="text-zinc-300 underline decoration-zinc-700 underline-offset-4 transition hover:text-zinc-200">$1</a>'
    )
    .replace(/`([^`]+)`/g, '<code class="rounded bg-zinc-900/80 px-1.5 py-0.5 text-[0.92em] text-zinc-200">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-zinc-100">$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em class="italic text-zinc-200">$1</em>');
}

function renderParagraph(block: string) {
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return '';
  }

  const headingMatch = lines[0].match(/^(#{1,3})\s+(.+)$/);

  if (headingMatch) {
    const [, hashes, title] = headingMatch;
    const tag = hashes.length === 1 ? 'h1' : hashes.length === 2 ? 'h2' : 'h3';
    const sizeClass =
      hashes.length === 1
        ? 'text-2xl font-semibold tracking-tight text-zinc-50'
        : hashes.length === 2
          ? 'text-xl font-semibold text-zinc-100'
          : 'text-base font-semibold uppercase tracking-[0.14em] text-zinc-300';

    return `<${tag} class="${sizeClass}">${renderInlineMarkdown(title)}</${tag}>`;
  }

  if (lines.every((line) => /^[-*]\s+/.test(line))) {
    const items = lines
      .map((line) => line.replace(/^[-*]\s+/, ''))
      .map((line) => `<li class="text-sm leading-7 text-zinc-300">${renderInlineMarkdown(line)}</li>`)
      .join('');

    return `<ul class="space-y-2 pl-5">${items}</ul>`;
  }

  return `<p class="text-sm leading-7 text-zinc-300">${lines
    .map((line) => renderInlineMarkdown(line))
    .join('<br />')}</p>`;
}

export function renderMarkdownToHtml(source: string) {
  const trimmedSource = source.trim();

  if (!trimmedSource) {
    return '<p class="text-sm leading-7 text-zinc-500">Nothing to preview yet. Write a few lines in Markdown and the rendered version will appear here.</p>';
  }

  const segments = trimmedSource.split(/```/);
  const html: string[] = [];

  segments.forEach((segment, index) => {
    if (index % 2 === 1) {
      const code = segment.replace(/^\w+\n/, '').trimEnd();
      html.push(
        `<pre class="overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-950/90 p-4 text-sm leading-6 text-zinc-200"><code>${escapeHtml(code)}</code></pre>`
      );
      return;
    }

    segment
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .forEach((block) => {
        html.push(renderParagraph(block));
      });
  });

  return html.join('');
}
