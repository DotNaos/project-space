import { useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  Check,
  FileCode2,
  FolderTree,
  Lock,
  ShieldOff,
  SlidersHorizontal,
  Tag,
  Unlock
} from 'lucide-react';
import { Button, Chip, Text } from '@/app/dotnaos-ui';
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

const ownedPathPreviewCount = 24;

function countRuleEntries(module: TemplateModule) {
  return module.rules.reduce((total, rule) => total + rule.entries.length, 0);
}

function ModuleListItem({
  isSelected,
  module,
  onSelect
}: {
  isSelected: boolean;
  module: TemplateModule;
  onSelect(): void;
}) {
  return (
    <button
      aria-current={isSelected ? 'true' : undefined}
      className={cn(
        'flex w-full min-w-0 flex-col gap-1 px-3 py-2.5 text-left transition',
        isSelected
          ? 'bg-neutral-800/80 text-neutral-100'
          : 'text-neutral-400 hover:bg-neutral-900/50 hover:text-neutral-200'
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Boxes className="size-3.5 shrink-0 text-neutral-600" />
        <span className="min-w-0 flex-1 truncate text-sm">{module.name}</span>
        {module.isDefault ? (
          <span className="shrink-0 text-[11px] text-neutral-600">default</span>
        ) : null}
      </span>
      <span className="truncate pl-5 text-[11px] text-neutral-600">
        {module.values.length} values · {countRuleEntries(module)} rules · {module.owns.length} owned
      </span>
    </button>
  );
}

function ModuleDetail({ module }: { module: TemplateModule }) {
  const [showAllOwned, setShowAllOwned] = useState(false);
  const summary = templateRuleKindSummary(module);
  const ownedPreview = showAllOwned ? module.owns : module.owns.slice(0, ownedPathPreviewCount);

  useEffect(() => {
    setShowAllOwned(false);
  }, [module.sourcePath]);

  return (
    <div className="min-w-0">
      <header className="border-b border-neutral-800/70 px-5 py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Boxes className="size-4 shrink-0 text-neutral-500" />
          <Text className="min-w-0 truncate text-base font-medium text-neutral-100">
            {module.name}
          </Text>
          {module.isDefault ? (
            <Chip size="sm" className="shrink-0 gap-1 text-neutral-500">
              <Check className="size-3" />
              Default
            </Chip>
          ) : null}
        </div>
        {module.description ? (
          <Text className="mt-1.5 block max-w-2xl text-sm leading-6 text-neutral-500">
            {module.description}
          </Text>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {summary.map(({ count, kind }) => {
            const Icon = kindIcon[kind];
            return (
              <Chip
                className={cn('shrink-0 gap-1', kindTone[kind])}
                key={kind}
                size="sm"
                title={templateRuleKindDescription(kind)}
              >
                <Icon className="size-3" />
                {count} {kind}
              </Chip>
            );
          })}
          <Chip size="sm" className="shrink-0 gap-1 text-neutral-600">
            <FileCode2 className="size-3" />
            {module.sourcePath}
          </Chip>
        </div>
      </header>

      {module.values.length > 0 ? (
        <section className="border-b border-neutral-800/70 px-5 py-4">
          <Text className="block text-[11px] font-medium text-neutral-600">
            Values every project supplies
          </Text>
          <dl className="mt-2 divide-y divide-neutral-800/50">
            {module.values.map((value) => (
              <div className="grid gap-1 py-2.5 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]" key={value.name}>
                <dt className="flex min-w-0 items-start gap-2">
                  <span className="min-w-0 break-all font-mono text-xs leading-6 text-neutral-300">
                    {value.name}
                  </span>
                  {value.required ? (
                    <Chip size="sm" className="mt-0.5 shrink-0 text-amber-300/90">required</Chip>
                  ) : null}
                </dt>
                <dd className="min-w-0 text-sm leading-6 text-neutral-500">
                  {value.description ?? `A ${value.type} value.`}
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-neutral-700">
                    <span>{value.type}</span>
                    {value.default ? <span>default {value.default}</span> : null}
                    {value.defaultFrom ? <span>from {value.defaultFrom}</span> : null}
                    {value.pattern ? <span className="break-all">{value.pattern}</span> : null}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {module.rules.length > 0 ? (
        <section className="border-b border-neutral-800/70 px-5 py-4">
          <Text className="block text-[11px] font-medium text-neutral-600">File rules</Text>
          <div className="mt-2 divide-y divide-neutral-800/50">
            {module.rules.map((rule) => (
              <div className="py-2.5" key={rule.file}>
                <div className="flex min-w-0 items-center gap-2">
                  <FileCode2 className="size-3.5 shrink-0 text-neutral-700" />
                  <Text className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-300">
                    {rule.file}
                  </Text>
                  {rule.format ? (
                    <Chip size="sm" className="shrink-0 text-neutral-700">{rule.format}</Chip>
                  ) : null}
                </div>
                <div className="mt-1.5 grid gap-1 pl-5">
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
        </section>
      ) : null}

      {module.owns.length > 0 ? (
        <section className="px-5 py-4">
          <Text className="block text-[11px] font-medium text-neutral-600">
            Paths the template owns ({module.owns.length})
          </Text>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ownedPreview.map((path) => (
              <span
                className="rounded-md bg-neutral-900/70 px-2 py-1 font-mono text-[11px] text-neutral-500"
                key={path}
              >
                {path}
              </span>
            ))}
          </div>
          {module.owns.length > ownedPathPreviewCount ? (
            <Button
              className="mt-2"
              onPress={() => setShowAllOwned((current) => !current)}
              size="sm"
              variant="ghost"
            >
              {showAllOwned
                ? 'Show fewer'
                : `Show all ${module.owns.length}`}
            </Button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export function TemplateContractView({
  contract,
  isLoading
}: {
  contract: TemplateContract;
  isLoading: boolean;
}) {
  const [selectedName, setSelectedName] = useState('');
  const selected = useMemo(
    () => contract.modules.find((module) => module.name === selectedName) ?? contract.modules[0],
    [contract.modules, selectedName]
  );

  if (isLoading && contract.modules.length === 0) {
    return (
      <Text className="block px-1 py-8 text-sm text-neutral-600">
        Reading the template contract…
      </Text>
    );
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
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-800/70">
        <div className="shrink-0 border-b border-neutral-800/70 px-3 py-2.5">
          <Text className="block text-[11px] font-medium text-neutral-600">
            Modules ({contract.modules.length})
          </Text>
        </div>
        <div className="min-h-0 flex-1 divide-y divide-neutral-800/50 overflow-y-auto">
          {contract.modules.map((module) => (
            <ModuleListItem
              isSelected={selected?.name === module.name}
              key={module.sourcePath}
              module={module}
              onSelect={() => setSelectedName(module.name)}
            />
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-800/70">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected ? (
            <ModuleDetail module={selected} />
          ) : (
            <div className="grid min-h-48 place-items-center px-6 text-center">
              <Text className="text-sm text-neutral-600">Select a module.</Text>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function TemplateContractSummary({ contract }: { contract: TemplateContract }) {
  if (!contract.manifest) return null;
  const ownedPaths = contract.modules.reduce((total, module) => total + module.owns.length, 0);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Chip size="sm" className="gap-1.5 text-neutral-400">
        <FileCode2 className="size-3" />
        {contract.manifest.name}
      </Chip>
      {contract.manifest.version ? (
        <Chip size="sm" className="gap-1.5 text-neutral-500">
          <Tag className="size-3" />
          {contract.manifest.version}
        </Chip>
      ) : null}
      <Chip size="sm" className="gap-1.5 text-neutral-500">
        <Boxes className="size-3" />
        {contract.modules.length} {contract.modules.length === 1 ? 'module' : 'modules'}
      </Chip>
      <Chip size="sm" className="gap-1.5 text-neutral-500">
        <FolderTree className="size-3" />
        {ownedPaths} owned paths
      </Chip>
    </div>
  );
}
