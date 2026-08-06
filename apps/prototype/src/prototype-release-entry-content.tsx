import type { ReactNode } from 'react';

import type { PrototypeReviewReleaseEntry } from '../../../src/shared/prototype-review-local-changelog-api';

export function PrototypeReleaseEntryContent({
  entry
}: {
  entry: PrototypeReviewReleaseEntry;
}) {
  return (
    <article aria-labelledby="prototype-release-title">
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span className="font-mono font-semibold text-neutral-300">v{entry.version}</span>
        <span aria-hidden>·</span>
        <span>{entry.areas.join(', ')}</span>
        <span aria-hidden>·</span>
        <span>PR #{entry.pullRequest}</span>
      </div>
      <h2 className="mt-3 text-xl font-semibold tracking-tight" id="prototype-release-title">
        {entry.title}
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-400">
        {entry.summary}
      </p>

      <ReleaseRow label="Changes">
        <div className="space-y-5">
          {entry.changes.map((change) => (
            <section key={change.category}>
              <h3 className="text-sm font-semibold">{change.category}</h3>
              <BulletList items={change.items} />
            </section>
          ))}
          {entry.breakingChanges.length ? (
            <section>
              <h3 className="text-sm font-semibold">Breaking changes</h3>
              <BulletList items={entry.breakingChanges} />
            </section>
          ) : null}
        </div>
      </ReleaseRow>

      <ReleaseRow label="Upgrade">
        <h3 className="text-sm font-semibold">
          {entry.upgrade === 'none' ? 'No manual upgrade' : 'Manual upgrade required'}
        </h3>
        <div className="mt-2 space-y-2 text-sm leading-6 text-neutral-400">
          {entry.upgradeNotes.map((note) => <p key={note}>{note}</p>)}
        </div>
      </ReleaseRow>

      <ReleaseRow label="Preview tests">
        <h3 className="text-sm font-semibold">What to test</h3>
        <BulletList items={entry.previewTests} />
      </ReleaseRow>

      <p className="mt-6 truncate border-t border-neutral-800 pt-4 font-mono text-[10px] text-neutral-600">
        Source: {entry.path}
      </p>
    </article>
  );
}

function ReleaseRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="mt-7 grid gap-3 border-t border-neutral-800 pt-5 sm:grid-cols-[7rem_minmax(0,1fr)]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-600">
        {label}
      </p>
      <div>{children}</div>
    </section>
  );
}

function BulletList({ items }: { items: readonly string[] }) {
  return (
    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6 text-neutral-400 marker:text-neutral-600">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}
