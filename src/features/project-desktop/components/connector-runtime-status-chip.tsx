import { Chip } from '@heroui/react';
import { Clock3, Download, LoaderCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ConnectorRuntimeUpdateRecord } from '@/shared/project-space-api';
import { connectorRuntimeStatusPresentation } from './connector-runtime-status-model';

export function ConnectorRuntimeStatusChip({
  className,
  update,
  updates
}: {
  className?: string;
  update?: ConnectorRuntimeUpdateRecord;
  updates?: readonly (ConnectorRuntimeUpdateRecord | undefined)[];
}) {
  const presentation = connectorRuntimeStatusPresentation(updates ?? [update]);
  if (!presentation) return null;

  const Icon = presentation.status === 'updating'
    ? LoaderCircle
    : presentation.status === 'update-pending'
      ? Clock3
      : Download;

  return (
    <Chip
      aria-label={presentation.label}
      color={presentation.status === 'update-pending' ? 'warning' : 'accent'}
      data-connector-runtime-status={presentation.status}
      size="sm"
      variant="soft"
      className={cn('shrink-0 gap-1', className)}
    >
      <Icon
        aria-hidden="true"
        className={cn('size-3', presentation.status === 'updating' && 'animate-spin')}
      />
      <Chip.Label>{presentation.label}</Chip.Label>
    </Chip>
  );
}
