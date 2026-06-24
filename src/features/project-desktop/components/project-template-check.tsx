import { AlertTriangle, CheckCircle2, CircleDashed, FileCheck2 } from 'lucide-react';
import { Chip, Text, Tooltip } from '@/app/dotnaos-ui';
import type { FullstackTemplateCheck } from '@/shared/project-space-api';

interface ProjectTemplateCheckPanelProps {
  check?: FullstackTemplateCheck;
}

const statusLabel: Record<FullstackTemplateCheck['status'], string> = {
  implemented: 'Implemented',
  partial: 'Partial',
  'not-detected': 'Not detected',
  'template-source': 'Template source'
};

function statusTone(status: FullstackTemplateCheck['status']): 'primary' | 'secondary' {
  if (status === 'implemented' || status === 'template-source') {
    return 'primary';
  }

  return 'secondary';
}

function StatusIcon({ status }: { status: FullstackTemplateCheck['status'] }) {
  if (status === 'implemented' || status === 'template-source') {
    return <CheckCircle2 className="size-4 text-emerald-300" />;
  }

  if (status === 'partial') {
    return <AlertTriangle className="size-4 text-amber-300" />;
  }

  return <CircleDashed className="size-4 text-slate-500" />;
}

export function ProjectTemplateStatusPill({ check }: ProjectTemplateCheckPanelProps) {
  if (!check || check.status === 'not-detected') {
    return null;
  }

  const matched = check.matched ?? [];
  const missing = check.missing ?? [];

  return (
    <Tooltip delay={0}>
      <Tooltip.Trigger>
        <Chip size="sm" variant={statusTone(check.status)} className="shrink-0">
          template {statusLabel[check.status].toLowerCase()}
        </Chip>
      </Tooltip.Trigger>
      <Tooltip.Content showArrow placement="right">
        <Tooltip.Arrow />
        {missing.length > 0
          ? `${missing.length} missing template checks`
          : `${matched.length} template checks matched`}
      </Tooltip.Content>
    </Tooltip>
  );
}

export function ProjectTemplateCheckPanel({ check }: ProjectTemplateCheckPanelProps) {
  if (!check) {
    return (
      <div className="flex min-w-0 items-start gap-2 text-slate-400">
        <StatusIcon status="not-detected" />
        <div className="min-w-0 leading-tight">
          <Text className="block text-sm font-medium text-slate-200">Fullstack template</Text>
          <Text className="block text-xs text-slate-500">
            Not detected
          </Text>
        </div>
      </div>
    );
  }

  const matched = check.matched ?? [];
  const missing = check.missing ?? [];
  const missingPreview = missing.slice(0, 12);
  const remainingMissing = Math.max(0, missing.length - missingPreview.length);

  return (
    <details className="group min-w-0">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-md px-0 py-1 text-left">
        <FileCheck2 className="size-4 shrink-0 text-slate-500" />
        <StatusIcon status={check.status} />
        <Text className="truncate text-sm font-medium text-slate-200">
          Fullstack template
        </Text>
        <Chip size="sm" variant={statusTone(check.status)}>
          {statusLabel[check.status]}
        </Chip>
        <Text className="shrink-0 text-xs text-slate-500">
          {check.score}% / {missing.length} gaps
        </Text>
        {missing.length > 0 ? (
          <Text className="ml-auto shrink-0 text-xs text-slate-500 group-open:hidden">
            Show gaps
          </Text>
        ) : null}
      </summary>

      <div className="mt-2 flex min-w-0 flex-wrap gap-1.5 pl-6">
        {missing.length > 0 ? (
          <>
            {missingPreview.map((item) => (
              <Chip key={item} size="sm" variant="secondary" className="max-w-full">
                <span className="truncate">{item}</span>
              </Chip>
            ))}
            {remainingMissing > 0 ? (
              <Chip size="sm" variant="tertiary">+{remainingMissing}</Chip>
            ) : null}
          </>
        ) : (
          <Text className="text-xs text-slate-500">
            {matched.length} template checks matched.
          </Text>
        )}
      </div>
    </details>
  );
}
