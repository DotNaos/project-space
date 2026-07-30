import { DocsArticleIdentity } from '@/components/docs-article-identity';
import {
  ReleaseGridRow,
  ReleasePublicationDetails,
} from '@/components/release-publication-details';
import { ReleaseScrollSpy } from '@/components/release-scroll-spy';
import { releaseCatalogResult } from '@/lib/releases/source';
import {
  compareStableSemver,
  releaseAnchor,
  releaseMinor,
} from '@/lib/releases/semver';
import { publishedReleaseEntry } from '@/lib/releases/preview';
import {
  previewTestsForCurrentBuild,
} from '@/lib/releases/preview-server';
import type {
  ReleaseChange,
  ReleaseEntry,
} from '@/lib/releases/types';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/layouts/docs/page';

export default async function ReleaseMinorPage(
  props: PageProps<'/docs/releases/[minor]'>,
) {
  await connection();
  const { minor } = await props.params;
  const entries = entriesForMinor(minor);
  if (entries.length === 0) notFound();
  const latest = entries[0];
  const anchors = entries.map((entry) =>
    releaseAnchor(entry.version),
  );

  return (
    <DocsPage
      footer={{ enabled: false }}
      full
      toc={[]}
    >
      <ReleaseScrollSpy anchors={anchors} />
      <DocsTitle>{minor} releases</DocsTitle>
      <DocsArticleIdentity title={`${minor} releases`} />
      <DocsDescription className="mb-0">
        All changes published in the {minor} release line. Latest
        version: v{latest.version}.
      </DocsDescription>
      <DocsBody>
        <div
          className="not-prose mx-auto mt-12 max-w-4xl"
          data-release-minor={minor}
        >
          {entries.map((entry, index) => (
            <ReleaseSection
              entry={entry}
              key={entry.version}
              latest={index === 0}
            />
          ))}
        </div>
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  if (!releaseCatalogResult.ok) return [];
  return [
    ...new Set(
      releaseCatalogResult.catalog.entries.map((entry) =>
        releaseMinor(entry.version),
      ),
    ),
  ].map((minor) => ({ minor }));
}

export async function generateMetadata(
  props: PageProps<'/docs/releases/[minor]'>,
): Promise<Metadata> {
  const { minor } = await props.params;
  const entries = entriesForMinor(minor);
  if (entries.length === 0) notFound();
  return {
    description: `All Project Space releases published in the ${minor} release line.`,
    title: `${minor} releases`,
  };
}

function ReleaseSection({
  entry,
  latest,
}: {
  entry: ReleaseEntry;
  latest: boolean;
}) {
  const anchor = releaseAnchor(entry.version);
  const previewTests = previewTestsForCurrentBuild(entry);
  const publishedEntry = publishedReleaseEntry(entry);
  return (
    <article
      aria-labelledby={`${anchor}-title`}
      className="scroll-mt-24 border-b border-fd-border py-14 focus:outline-none first:pt-0 last:border-b-0"
      data-release-anchor={anchor}
      data-release-latest={latest || undefined}
      id={anchor}
      tabIndex={-1}
    >
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-fd-primary">
            v{entry.version}
          </span>
          {latest && (
            <span className="rounded-full border border-fd-border px-2 py-0.5 text-xs font-medium text-fd-muted-foreground">
              Latest in {releaseMinor(entry.version)}
            </span>
          )}
        </div>
        <h2
          className="mt-3 text-2xl font-semibold tracking-tight text-fd-foreground sm:text-3xl"
          id={`${anchor}-title`}
        >
          {entry.title}
        </h2>
        <ReleasePublicationDetails entry={publishedEntry}>
          <ReleaseGridRow label="Summary">
            <p>{entry.summary}</p>
          </ReleaseGridRow>
          <ReleaseGridRow label="Changes">
            <div className="space-y-6">
              {entry.changes.map((change) => (
                <ChangeCategory
                  change={change}
                  key={change.category}
                />
              ))}
              {entry.breakingChanges.length > 0 && (
                <div>
                  <h3 className="font-semibold text-fd-foreground">
                    Breaking changes
                  </h3>
                  <BulletList items={entry.breakingChanges} />
                </div>
              )}
            </div>
          </ReleaseGridRow>
          <ReleaseGridRow label="Upgrade">
            <div>
              <h3 className="font-semibold text-fd-foreground">
                {entry.upgrade === 'none'
                  ? 'No manual upgrade'
                  : 'Manual upgrade required'}
              </h3>
              <div className="mt-3 space-y-2">
                {entry.upgradeNotes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            </div>
          </ReleaseGridRow>
          {previewTests && (
            <ReleaseGridRow label="Preview tests">
              <div data-preview-only>
                <h3 className="font-semibold text-fd-foreground">
                  What to test
                </h3>
                <BulletList items={previewTests} />
              </div>
            </ReleaseGridRow>
          )}
        </ReleasePublicationDetails>
      </div>
    </article>
  );
}

function ChangeCategory({
  change,
}: {
  change: ReleaseChange;
}) {
  return (
    <div>
      <h3 className="font-semibold text-fd-foreground">
        {change.category}
      </h3>
      <BulletList items={change.items} />
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="mt-3 list-disc space-y-2 pl-5 marker:text-fd-muted-foreground">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function entriesForMinor(minor: string) {
  if (!releaseCatalogResult.ok) return [];
  return releaseCatalogResult.catalog.entries
    .filter((entry) => releaseMinor(entry.version) === minor)
    .sort((left, right) =>
      compareStableSemver(right.version, left.version),
    );
}
