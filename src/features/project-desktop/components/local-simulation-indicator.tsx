import { useState } from 'react';
import { Button, Popover } from '@heroui/react';
import { RotateCcw } from 'lucide-react';

import { projectSpaceClient } from '@/api/project-space-client';
import type { AppMeta } from '@/shared/project-space-api';

export function LocalSimulationIndicator({
  compact = false,
  runtime
}: {
  compact?: boolean;
  runtime?: AppMeta['runtime'];
}) {
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState('');
  if (runtime?.apis !== 'simulated' || runtime.data !== 'local') return null;

  async function reset() {
    setIsResetting(true);
    setError('');
    try {
      await projectSpaceClient.resetLocalSimulation();
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not reset the simulation.');
      setIsResetting(false);
    }
  }

  return (
    <Popover>
      <Popover.Trigger
        aria-label="Local simulation details"
        className={`inline-flex h-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/[.04] text-[10px] font-medium tracking-wide text-neutral-400 outline-none transition hover:bg-white/[.07] hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-neutral-600 ${compact ? 'w-5 px-0' : 'px-2'}`}
      >
        {compact ? <span aria-hidden="true" className="size-1.5 rounded-full bg-neutral-500" /> : 'Local simulation'}
      </Popover.Trigger>
      <Popover.Content
        className="w-72 rounded-2xl border border-neutral-700 bg-neutral-900/95 p-4 text-neutral-100 shadow-2xl shadow-black/60 backdrop-blur-xl"
        offset={8}
        placement="bottom"
      >
        <Popover.Dialog className="outline-none">
          <p className="text-sm font-semibold">Local simulation</p>
          <p className="mt-1 text-xs leading-5 text-neutral-400">
            Provider APIs are simulated, data stays on this computer, and outbound network access is blocked.
          </p>
          <Button
            className="mt-3"
            isDisabled={isResetting}
            onPress={() => void reset()}
            size="sm"
            variant="secondary"
          >
            <RotateCcw className="size-3.5" />
            {isResetting ? 'Resetting…' : 'Reset scenario'}
          </Button>
          {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
