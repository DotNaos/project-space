import type { ProjectStructureViolationRecord } from '@/shared/project-space-api';
import { Text } from '@/app/dotnaos-ui';
import { AlertTriangle, CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export function machineIdForViolation(
  violation: ProjectStructureViolationRecord,
  localMachineId: string
) {
  return violation.machineId ?? localMachineId;
}

function violationTone(violation: ProjectStructureViolationRecord) {
  return violation.severity === 'error'
    ? {
        border: 'border-red-500/20',
        icon: 'text-red-300',
        text: 'text-red-200'
      }
    : {
        border: 'border-amber-500/20',
        icon: 'text-amber-300',
        text: 'text-amber-200'
      };
}

export function StructureViolationRow({
  actions,
  violation
}: {
  actions?: ReactNode;
  violation: ProjectStructureViolationRecord;
}) {
  const tone = violationTone(violation);
  const Icon = violation.severity === 'error' ? CircleAlert : AlertTriangle;

  return (
    <div className={`my-1 min-w-0 border-l-2 ${tone.border} py-1 pl-3 pr-1`}>
      <div className="flex min-w-0 items-start gap-2">
        <Icon className={`mt-0.5 size-3.5 shrink-0 ${tone.icon}`} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <Text className={`block truncate text-xs font-semibold ${tone.text}`}>
                {violation.title}
              </Text>
              <Text className="mt-0.5 block truncate font-mono text-xs text-neutral-500">
                {violation.relativePath}
              </Text>
            </div>
            {actions ? <div className="shrink-0">{actions}</div> : null}
          </div>
          <Text className="mt-1 block text-xs leading-5 text-neutral-500">
            {violation.detail}
          </Text>
        </div>
      </div>
    </div>
  );
}
