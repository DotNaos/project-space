import { FlaskConical } from 'lucide-react';

import { Chip } from '@/app/dotnaos-ui';
import type { MachineRecord } from '@/shared/project-space-api';
import { isDevelopmentConnector } from './connector-channel-model';

export { isDevelopmentConnector } from './connector-channel-model';

export function ConnectorChannelChip({
  machine
}: {
  machine?: Pick<MachineRecord, 'connector' | 'name'>;
}) {
  if (!isDevelopmentConnector(machine)) {
    return null;
  }

  return (
    <Chip
      aria-label="Development connector"
      data-connector-channel="dev"
      size="sm"
      variant="soft"
      className="gap-1 rounded-full border border-violet-400/25 bg-violet-400/10 px-1.5 py-0.5 font-semibold text-violet-200"
    >
      <FlaskConical aria-hidden="true" className="size-3" />
      Dev
    </Chip>
  );
}
