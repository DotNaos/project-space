import { useState, type ReactNode } from 'react';

export interface CollapsibleSectionProps {
  children: ReactNode;
  defaultExpanded?: boolean;
  expanded?: boolean;
  id: string;
  insetContent?: boolean;
  leading?: ReactNode;
  onExpandedChange?(expanded: boolean): void;
  separated?: boolean;
  summary?: ReactNode;
  title: string;
}

export function CollapsibleSection({
  children,
  defaultExpanded = true,
  expanded: controlledExpanded,
  id,
  insetContent = false,
  leading,
  onExpandedChange,
  separated = false,
  summary,
  title,
}: CollapsibleSectionProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const expanded = controlledExpanded ?? uncontrolledExpanded;
  const contentId = `${id}-content`;

  function toggle() {
    const next = !expanded;
    if (controlledExpanded === undefined) setUncontrolledExpanded(next);
    onExpandedChange?.(next);
  }

  return (
    <section
      className={separated ? 'border-b border-border/80 bg-bg-1/20' : 'border-b border-border/80'}
      data-separated={separated || undefined}
      data-ui-component="CollapsibleSection"
    >
      <h2>
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          className="flex min-h-9 w-full items-center px-2 text-left text-xs text-text-muted transition-colors hover:bg-control-hover/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          onClick={toggle}
          type="button"
        >
          <span className="flex min-w-0 items-center gap-2">
            {leading}
            <span className="truncate font-medium text-text-muted">{title}</span>
            {summary ? <span className="shrink-0 tabular-nums text-text-muted/70" data-section-summary="true">{summary}</span> : null}
          </span>
        </button>
      </h2>
      {expanded ? <div className={insetContent ? 'ml-4 sm:ml-6' : undefined} id={contentId}>{children}</div> : null}
    </section>
  );
}
