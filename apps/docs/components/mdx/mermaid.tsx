import { renderMermaidSVG } from 'beautiful-mermaid';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';

export async function Mermaid({ chart }: { chart: string }) {
  try {
    const svg = renderMermaidSVG(chart, {
      bg: 'var(--color-fd-background)',
      fg: 'var(--color-fd-foreground)',
      interactive: true,
      transparent: true,
    });

    return (
      <div
        aria-label="Architecture diagram"
        className="my-6 overflow-x-auto rounded-lg border bg-fd-card p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        data-testid="mermaid-diagram"
        dangerouslySetInnerHTML={{ __html: svg }}
        role="img"
      />
    );
  } catch {
    return (
      <CodeBlock title="Mermaid diagram">
        <Pre>{chart}</Pre>
      </CodeBlock>
    );
  }
}
