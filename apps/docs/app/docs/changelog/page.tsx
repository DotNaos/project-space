import { changelogCatalogResult } from '@/lib/changelog/source';
import {
  buildChangelogView,
  parseChangelogFilters,
  type ChangelogEntry,
  type ChangelogGroup,
  type ChangelogView,
} from '@/lib/changelog/model';
import { AlertTriangle, ArrowRight, CheckCircle2, GitPullRequest } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/layouts/docs/page';

export const metadata: Metadata = {
  title: 'Changelog',
  description: 'Release notes and pull request testing guidance for Project Space.',
};

type SearchParams = Record<string, string | string[] | undefined>;

interface ChangelogPageProps {
  searchParams: Promise<SearchParams>;
}

const categoryLabels: Record<ChangelogEntry['category'], string> = {
  added: 'Added',
  changed: 'Changed',
  fixed: 'Fixed',
  deprecated: 'Deprecated',
  removed: 'Removed',
  security: 'Security',
};

const categoryStyles: Record<ChangelogEntry['category'], string> = {
  added: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  changed: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  fixed: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  deprecated: 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300',
  removed: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
  security: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
};

export default async function ChangelogPage({ searchParams }: ChangelogPageProps) {
  const rawSearchParams = await searchParams;
  const filterResult = parseChangelogFilters(rawSearchParams);

  return (
    <DocsPage toc={[]} full>
      <DocsTitle>Changelog</DocsTitle>
      <DocsDescription>
        Release notes and concrete testing guidance, read from this exact source revision.
      </DocsDescription>
      <DocsBody>
        <FilterForm searchParams={rawSearchParams} />
        {!filterResult.ok ? (
          <MessageState title="The filters are invalid" message={filterResult.message} />
        ) : !changelogCatalogResult.ok ? (
          <MessageState
            title="The changelog source is invalid"
            message="Release notes cannot be shown because this source revision contains contradictory or incomplete changelog metadata."
          />
        ) : (
          <ChangelogResults
            view={buildChangelogView(changelogCatalogResult.catalog, filterResult.filters)}
          />
        )}
      </DocsBody>
    </DocsPage>
  );
}

function FilterForm({ searchParams }: { searchParams: SearchParams }) {
  const currentPr = typeof searchParams.pr === 'string' ? searchParams.pr : '';
  const currentVersion =
    typeof searchParams.version === 'string' ? searchParams.version : '';

  return (
    <section
      aria-labelledby="changelog-filters"
      className="not-prose my-8 border-y border-fd-border py-5"
    >
      <div className="mb-4">
        <h2 id="changelog-filters" className="text-base font-semibold text-fd-foreground">
          Find changes
        </h2>
        <p className="mt-1 text-sm text-fd-muted-foreground">
          Filter by a public GitHub pull request number, a published version, or both.
        </p>
      </div>
      <form action="/docs/changelog" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto]">
        <label className="grid gap-1.5 text-sm font-medium text-fd-foreground">
          Pull request
          <input
            name="pr"
            type="text"
            inputMode="numeric"
            pattern="[1-9][0-9]*"
            defaultValue={currentPr}
            placeholder="298"
            className="h-10 rounded-lg border border-fd-border bg-fd-background px-3 text-sm text-fd-foreground outline-none transition focus:border-fd-primary focus:ring-2 focus:ring-fd-primary/20"
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-fd-foreground">
          Version
          <input
            name="version"
            type="text"
            defaultValue={currentVersion}
            placeholder="0.4.36"
            className="h-10 rounded-lg border border-fd-border bg-fd-background px-3 text-sm text-fd-foreground outline-none transition focus:border-fd-primary focus:ring-2 focus:ring-fd-primary/20"
          />
        </label>
        <div className="flex items-end gap-3">
          <button
            type="submit"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-fd-primary px-4 text-sm font-semibold text-fd-primary-foreground transition hover:opacity-90"
          >
            Apply filters
            <ArrowRight aria-hidden className="size-4" />
          </button>
          {(currentPr || currentVersion) && (
            <Link
              href="/docs/changelog"
              className="inline-flex h-10 items-center text-sm font-medium text-fd-muted-foreground no-underline hover:text-fd-foreground"
            >
              Clear
            </Link>
          )}
        </div>
      </form>
    </section>
  );
}

function ChangelogResults({ view }: { view: ChangelogView }) {
  if (view.state !== 'ready') {
    return (
      <MessageState
        title={view.state === 'contradictory' ? 'These filters contradict each other' : 'No matching changelog'}
        message={view.message}
      />
    );
  }

  if (view.groups.length === 0) {
    return (
      <MessageState
        title="No changelog entries yet"
        message="This source revision contains no documented changes."
      />
    );
  }

  return (
    <div className="not-prose space-y-12">
      {view.groups.map((group) => (
        <ChangelogSection
          key={group.key}
          group={group}
          highlightedPullRequest={view.highlightedPullRequest}
        />
      ))}
    </div>
  );
}

function ChangelogSection({
  group,
  highlightedPullRequest,
}: {
  group: ChangelogGroup;
  highlightedPullRequest?: number;
}) {
  return (
    <section aria-labelledby={`changelog-${group.key}`}>
      <header className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-fd-border pb-3">
        <h2 id={`changelog-${group.key}`} className="text-2xl font-semibold tracking-tight">
          {group.label}
        </h2>
        {group.releasedAt && (
          <time dateTime={group.releasedAt} className="text-sm text-fd-muted-foreground">
            Released {formatDate(group.releasedAt)}
          </time>
        )}
      </header>
      <div className="divide-y divide-fd-border">
        {group.entries.map((entry) => (
          <ChangelogEntryRow
            key={entry.id}
            entry={entry}
            highlighted={entry.pullRequestNumber === highlightedPullRequest}
          />
        ))}
      </div>
    </section>
  );
}

function ChangelogEntryRow({
  entry,
  highlighted,
}: {
  entry: ChangelogEntry;
  highlighted: boolean;
}) {
  return (
    <article
      className={`scroll-mt-24 py-6 first:pt-0 last:pb-0 ${
        highlighted ? 'border-l-2 border-fd-primary pl-4 sm:pl-5' : ''
      }`}
      data-highlighted={highlighted || undefined}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${categoryStyles[entry.category]}`}
        >
          {categoryLabels[entry.category]}
        </span>
        <Link
          href={`https://github.com/DotNaos/project-space/pull/${entry.pullRequestNumber}`}
          className="inline-flex items-center gap-1 text-sm font-medium text-fd-muted-foreground no-underline hover:text-fd-foreground"
        >
          <GitPullRequest aria-hidden className="size-4" />
          PR #{entry.pullRequestNumber}
        </Link>
        {entry.issueNumber && (
          <Link
            href={`https://github.com/DotNaos/project-space/issues/${entry.issueNumber}`}
            className="text-sm font-medium text-fd-muted-foreground no-underline hover:text-fd-foreground"
          >
            Issue #{entry.issueNumber}
          </Link>
        )}
        {highlighted && (
          <span className="text-xs font-semibold uppercase tracking-wide text-fd-primary">
            Selected PR
          </span>
        )}
      </div>
      <h3 className="text-lg font-semibold leading-snug text-fd-foreground">
        {entry.summary}
      </h3>
      <p className="mt-2 leading-7 text-fd-muted-foreground">{entry.body}</p>
      <div className="mt-5">
        <h4 className="text-sm font-semibold uppercase tracking-wide text-fd-foreground">
          What to test
        </h4>
        <ul className="mt-3 space-y-2">
          {entry.testing.map((guidance) => (
            <li key={guidance} className="flex gap-2.5 text-sm leading-6 text-fd-muted-foreground">
              <CheckCircle2
                aria-hidden
                className="mt-1 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              />
              <span>{guidance}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

function MessageState({ title, message }: { title: string; message: string }) {
  return (
    <section className="not-prose my-10 border-l-2 border-amber-500 py-1 pl-4 sm:pl-5">
      <div className="flex gap-3">
        <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0 text-amber-500" />
        <div>
          <h2 className="font-semibold text-fd-foreground">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-fd-muted-foreground">{message}</p>
          <Link
            href="/docs/changelog"
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-fd-primary no-underline"
          >
            View the complete changelog
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00.000Z`));
}
