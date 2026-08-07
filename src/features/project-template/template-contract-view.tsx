import { Boxes, FileCode2, Lock, ShieldOff, SlidersHorizontal, Unlock } from 'lucide-react';
import { Chip, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import {
  templateRuleKindDescription,
  templateRuleKindSummary,
  type TemplateModule,
  type TemplateRuleKind
} from './template-contract-model';
import type { TemplateContract } from './use-template-repository';

const kindTone: Record<TemplateRuleKind, string> = {
  deny: 'text-red-300',
  frozen: 'text-sky-300',
  open: 'text-emerald-300',
  slot: 'text-amber-300',
  unknown: 'text-neutral-500'
};

const kindIcon: Record<TemplateRuleKind, typeof Lock> = {
  deny: ShieldOff,
  frozen: Lock,
  open: Unlock,
  slot: SlidersHorizontal,
  unknown: FileCode2
};

function RuleKindChip({ count, kind }: { count: number; kind: TemplateRuleKind }) {
  const Icon = kindIcon[kind];
  return (
    <Chip size="sm" className={cn('shrink-0 gap-1', kindTone[kind])} title={templateRuleKindDescription(kind)}>
      <Icon className="size-3" />
      {count} {kind}
    </Chip>
  );
}

function ModuleSection({ module }: { module: TemplateModule }) {
  const summary = templateRuleKindSummary(module);

  return (
    <section className="border-b border-neutral-800/70 py-6 last:border-b-0">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Boxes className="size-4 shrink-0 text-neutral-500" />
            <Text className="truncate text-base font-medium text-neutral-100">{module.name}</Text>
            {module.isDefault ? (
              <Chip size="sm" className="shrink-0 text-neutral-600">Default</Chip>
            ) : null}
          </div>
          {module.description ? (
            <Text className="mt-1 block max-w-2xl text-sm leading-6 text-neutral-500">
              {module.description}
            </Text>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {summary.map((entry) => (
            <RuleKindChip count={entry.count} key={entry.kind} kind={entry.kind} />
          ))}
        </div>
      </header>

      {module.values.length > 0 ? (
        <div className="mt-5">
          <Text className="block text-[11px] font-medium text-neutral-600">
            Values every project supplies
          </Text>
          <dl className="mt-1 divide-y divide-neutral-800/50">
            {module.values.map((value) => (
              <div className="grid gap-1 py-2.5 sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]" key={value.name}>
                <dt className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 break-all font-mono text-xs text-neutral-300">{value.name}</span>
                  {value.required ? (
                    <Chip size="sm" className="shrink-0 text-amber-300/90">required</Chip>
                  ) : null}
                </dt>
                <dd className="min-w-0 text-sm leading-6 text-neutral-500">
                  {value.description ?? `A ${value.type} value.`}
                  <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-700">
                    <span className="font-mono">{value.type}</span>
                    {value.default ? <span className="font-mono">default {value.default}</span> : null}
                    {value.defaultFrom ? <span className="font-mono">from {value.defaultFrom}</span> : null}
                    {value.pattern ? <span className="truncate font-mono">{value.pattern}</span> : null}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {module.rules.length > 0 ? (
        <div className="mt-5">
          <Text className="block text-[11px] font-medium text-neutral-600">File rules</Text>
          <div className="mt-1 divide-y divide-neutral-800/50">
            {module.rules.map((rule) => (
              <div className="py-2.5" key={rule.file}>
                <div className="flex min-w-0 items-center gap-2">
                  <FileCode2 className="size-3.5 shrink-0 text-neutral-700" />
                  <Text className="truncate font-mono text-xs text-neutral-300">{rule.file}</Text>
                  {rule.format ? (
                    <Chip size="sm" className="shrink-0 text-neutral-700">{rule.format}</Chip>
                  ) : null}
                </div>
                <div className="mt-2 grid gap-1">
                  {rule.entries.map((entry) => {
                    const Icon = kindIcon[entry.kind];
                    return (
                      <div
                        className="flex min-w-0 items-center gap-2 text-[11px]"
                        key={`${entry.kind}-${entry.path}`}
                        title={templateRuleKindDescription(entry.kind)}
                      >
                        <Icon className={cn('size-3 shrink-0', kindTone[entry.kind])} />
                        <span className="min-w-0 flex-1 truncate font-mono text-neutral-400">
                          {entry.path}
                        </span>
                        <span className={cn('shrink-0', kindTone[entry.kind])}>{entry.kind}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {module.owns.length > 0 ? (
        <div className="mt-5">
          <Text className="block text-[11px] font-medium text-neutral-600">
            Paths the template owns ({module.owns.length})
          </Text>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {module.owns.map((path) => (
              <span
                className="rounded-md bg-neutral-900/70 px-2 py-1 font-mono text-[11px] text-neutral-500"
                key={path}
              >
                {path}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function TemplateContractView({
  contract,
  isLoading
}: {
  contract: TemplateContract;
  isLoading: boolean;
}) {
  if (isLoading && contract.modules.length === 0) {
    return <Text className="block px-1 py-8 text-sm text-neutral-600">Reading the template contract…</Text>;
  }

  if (contract.modules.length === 0) {
    return (
      <div className="grid min-h-48 place-items-center px-6 text-center">
        <Text className="max-w-md text-sm text-neutral-500">
          {contract.message ?? 'This branch defines no template modules.'}
        </Text>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {contract.manifest ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-800/70 pb-4 text-[11px] text-neutral-600">
          <span className="font-mono text-neutral-400">{contract.manifest.name}</span>
          {contract.manifest.version ? <span>version {contract.manifest.version}</span> : null}
          <span>
            {contract.modules.length} {contract.modules.length === 1 ? 'module' : 'modules'}
          </span>
        </div>
      ) : null}
      {contract.modules.map((module) => (
        <ModuleSection key={module.sourcePath} module={module} />
      ))}
    </div>
  );
}
