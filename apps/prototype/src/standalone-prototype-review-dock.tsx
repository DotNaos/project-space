import { useState } from 'react';
import { Button } from '@heroui/react';
import { ScrollText } from 'lucide-react';

import { PrototypeReviewCodexDock } from '../../../src/features/pr-preview-review/prototype-review-codex-dock';
import { PrototypeReviewCodexStatus } from '../../../src/features/pr-preview-review/prototype-review-codex-status';
import { usePrototypeReviewLocalContext } from '../../../src/features/pr-preview-review/use-prototype-review-local-context';
import { type PrototypeTheme } from '../../../src/shared/prototype-canvas';
import type { PrototypeAnnotation } from '../../../src/shared/prototype-annotation-bridge';
import { PrototypeChangelogModal } from './prototype-changelog-modal';

const noAnnotations: readonly PrototypeAnnotation[] = [];

function localStatusMessage(
  state: ReturnType<typeof usePrototypeReviewLocalContext>
) {
  if (state.state === 'loading') return 'Connecting to this Codex task…';
  const reason = state.context?.codex.state === 'unavailable'
    ? state.context.codex.reason
    : undefined;
  if (reason === 'missing-thread') return 'No owning Codex task is attached.';
  if (reason === 'task-mismatch') return 'This prototype belongs to another Codex task.';
  return 'The local Codex composer is unavailable.';
}

export function StandalonePrototypeReviewDock({
  theme
}: {
  theme: PrototypeTheme;
}) {
  const [changelogOpen, setChangelogOpen] = useState(false);
  const localContext = usePrototypeReviewLocalContext({ enabled: true });
  const codex = localContext.context?.codex;
  const development = codex?.state === 'available'
    ? {
        connectionKind: 'local' as const,
        machineId: codex.machineId,
        source: 'local-runtime' as const,
        threadId: codex.threadId
      }
    : undefined;

  return (
    <>
      <footer className="prototype-review-dock">
        <div className="prototype-review-dock__changes">
          <Button
            aria-label="Open prototype changelog"
            className="prototype-review-dock__changelog"
            size="sm"
            variant="ghost"
            onPress={() => setChangelogOpen(true)}
          >
            <ScrollText className="size-4" />
            <span>Changelog</span>
          </Button>
        </div>

        <div className="prototype-review-dock__composer">
          {development ? (
            <PrototypeReviewCodexDock
              annotations={noAnnotations}
              annotationsEnabled={false}
              development={development}
              onAnnotationsSent={() => undefined}
              onToggleAnnotations={() => undefined}
              theme={theme}
            />
          ) : (
            <PrototypeReviewCodexStatus
              isConnecting={localContext.state === 'loading'}
              message={localStatusMessage(localContext)}
              theme={theme}
              onRetry={localContext.retry}
            />
          )}
        </div>
      </footer>

      <PrototypeChangelogModal
        isOpen={changelogOpen}
        onOpenChange={setChangelogOpen}
        theme={theme}
      />
    </>
  );
}
