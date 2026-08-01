import { Checkbox } from '@heroui/react';

import type {
  PrototypeReviewChecklistItem,
  PrototypeReviewLocalChangelogSnapshot
} from '../../../src/shared/prototype-review-local-changelog-api';

export function PrototypeWipReview({
  error,
  onSave,
  saving,
  snapshot
}: {
  error?: string;
  onSave(items: readonly PrototypeReviewChecklistItem[]): Promise<void>;
  saving: boolean;
  snapshot: PrototypeReviewLocalChangelogSnapshot;
}) {
  const items = snapshot.review.items;

  return (
    <section aria-label="Prototype review">
      <div className="divide-y divide-neutral-800/80">
        {items.length ? items.map((item) => (
          <Checkbox
            className="flex w-full items-center gap-3 py-3"
            isDisabled={saving}
            isSelected={item.reviewed}
            key={item.id}
            variant="secondary"
            onChange={(reviewed) => void onSave(items.map((candidate) =>
              candidate.id === item.id ? { ...candidate, reviewed } : candidate
            ))}
          >
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <Checkbox.Content className="min-w-0 text-sm">
              {item.label}
            </Checkbox.Content>
          </Checkbox>
        )) : (
          <p className="py-8 text-center text-sm text-neutral-500">
            The current prototype is unavailable for review.
          </p>
        )}
      </div>
      {error ? <p className="mt-3 text-xs text-rose-400" role="alert">{error}</p> : null}
    </section>
  );
}
