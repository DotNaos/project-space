import { changelogCatalogResult } from '@/lib/changelog/source';
import { ChangelogPrototypeAction } from '@/components/changelog-prototype-action';
import {
  buildChangelogView,
  parseChangelogFilters,
  type ChangelogEntry,
  type ChangelogGroup,
  type ChangelogView,
} from '@/lib/changelog/model';
import { ArrowRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/layouts/docs/page';
import { DocsArticleIdentity } from '@/components/docs-article-identity';

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

export default async function ChangelogPage({ searchParams }: ChangelogPageProps) {
  const rawSearchParams = await searchParams;
  const filterResult = parseChangelogFilters(rawSearchParams);

  return (
    <DocsPage toc={[]} full>
      <DocsTitle>Changelog</DocsTitle>
      <DocsArticleIdentity title="Changelog" />
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
      className="not-prose my-10"
    >
      <div className="mb-3">
        <h2 id="changelog-filters" className="text-sm font-medium text-fd-foreground">
          Filter releases
        </h2>
        <p className="mt-1 text-sm text-fd-muted-foreground">
          Search by pull request or published version.
        </p>
      </div>
      <form
        action="/docs/changelog"
        className="grid max-w-2xl gap-3 sm:grid-cols-[1fr_1fr_auto]"
      >
        <label className="grid gap-1.5 text-xs font-medium text-fd-muted-foreground">
          Pull request number
          <input
            name="pr"
            type="text"
            inputMode="numeric"
            pattern="[1-9][0-9]*"
            defaultValue={currentPr}
            placeholder="298"
            className="h-9 rounded-md border border-fd-border bg-transparent px-3 text-sm text-fd-foreground outline-none transition focus:border-fd-foreground focus:ring-2 focus:ring-fd-primary/15"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-fd-muted-foreground">
          Version
          <input
            name="version"
            type="text"
            defaultValue={currentVersion}
            placeholder="0.4.36"
            className="h-9 rounded-md border border-fd-border bg-transparent px-3 text-sm text-fd-foreground outline-none transition focus:border-fd-foreground focus:ring-2 focus:ring-fd-primary/15"
          />
        </label>
        <div className="flex items-end gap-3">
          <button
            type="submit"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-fd-primary px-3 text-sm font-medium text-fd-primary-foreground transition hover:opacity-90"
          >
            Apply
            <ArrowRight aria-hidden className="size-4" />
          </button>
          {(currentPr || currentVersion) && (
            <Link
              href="/docs/changelog"
              className="inline-flex h-9 items-center text-sm text-fd-muted-foreground no-underline hover:text-fd-foreground"
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
    <div className="not-prose space-y-16">
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
      <header className="mb-8">
        <h2 id={`changelog-${group.key}`} className="text-3xl font-semibold tracking-tight">
          {group.label}
        </h2>
        {group.releasedAt && (
          <time
            dateTime={group.releasedAt}
            className="mt-2 block text-sm text-fd-muted-foreground"
          >
            {formatDate(group.releasedAt)}
          </time>
        )}
      </header>
      <div className="space-y-12">
        {group.entries.map((entry) => (
          <ChangelogEntryRow
            key={entry.id}
            entry={entry}
            highlighted={entry.pullRequestNumber === highlightedPullRequest}
          />
        ))}
      </div>
      {group.releaseTesting.map((testing) => (
        <section
          aria-labelledby={`release-testing-${group.key}-${testing.pullRequestNumber}`}
          className="mt-12 border-t border-fd-border pt-8"
          key={testing.pullRequestNumber}
        >
          <h3
            className="text-xl font-semibold text-fd-foreground"
            id={`release-testing-${group.key}-${testing.pullRequestNumber}`}
          >
            What to test
          </h3>
          <p className="mt-2 text-sm text-fd-muted-foreground">
            Preview-only checks for PR #{testing.pullRequestNumber}
          </p>
          <ul className="mt-4 list-disc space-y-2 pl-5 marker:text-fd-muted-foreground">
            {testing.items.map((guidance) => (
              <li
                className="pl-1 text-sm leading-6 text-fd-muted-foreground"
                key={guidance}
              >
                {guidance}
              </li>
            ))}
          </ul>
        </section>
      ))}
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
      className="scroll-mt-24"
      data-highlighted={highlighted || undefined}
    >
      <h3 className="text-xl font-semibold leading-snug text-fd-foreground">
        {entry.summary}
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-fd-muted-foreground">
        <span>
          {categoryLabels[entry.category]}
        </span>
        <span aria-hidden>·</span>
        <Link
          href={`https://github.com/DotNaos/project-space/pull/${entry.pullRequestNumber}`}
          className="text-fd-muted-foreground underline decoration-fd-border underline-offset-4 hover:text-fd-foreground"
        >
          PR #{entry.pullRequestNumber}
        </Link>
        {entry.issueNumber && (
          <>
            <span aria-hidden>·</span>
            <Link
              href={`https://github.com/DotNaos/project-space/issues/${entry.issueNumber}`}
              className="text-fd-muted-foreground underline decoration-fd-border underline-offset-4 hover:text-fd-foreground"
            >
              Issue #{entry.issueNumber}
            </Link>
          </>
        )}
      </div>
      <p className="mt-4 max-w-3xl leading-7 text-fd-muted-foreground">{entry.body}</p>
      {entry.prototype && (
        <ChangelogPrototypeAction
          changeId={entry.id}
          prototype={entry.prototype}
          pullRequestNumber={entry.pullRequestNumber}
          title={entry.summary}
        />
      )}
      {entry.testing.length > 0 && (
        <div className="mt-6">
          <h4 className="text-base font-semibold text-fd-foreground">
            What to test
          </h4>
          <ul className="mt-3 list-disc space-y-2 pl-5 marker:text-fd-muted-foreground">
            {entry.testing.map((guidance) => (
              <li key={guidance} className="pl-1 text-sm leading-6 text-fd-muted-foreground">
                {guidance}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function MessageState({ title, message }: { title: string; message: string }) {
  return (
    <section className="not-prose my-12 max-w-2xl">
      <h2 className="text-lg font-semibold text-fd-foreground">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{message}</p>
      <Link
        href="/docs/changelog"
        className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-fd-primary no-underline"
      >
        View the complete changelog
        <ArrowRight aria-hidden className="size-4" />
      </Link>
    </section>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00.000Z`));
}
