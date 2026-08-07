import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ExternalLink, GitBranch, Plus, RefreshCw } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import { projectTemplateRepository } from './template-contract-model';
import { TemplateContractView } from './template-contract-view';
import { TemplateFeatureDialog } from './template-feature-dialog';
import { TemplateFileExplorer } from './template-file-explorer';
import {
  useTemplateBranches,
  useTemplateContract,
  useTemplateFile,
  useTemplateTree
} from './use-template-repository';

type TemplateTab = 'contract' | 'files' | 'project check';

export function ProjectTemplatePage({ projectCheck }: { projectCheck?: ReactNode }) {
  const branches = useTemplateBranches();
  const [selectedRef, setSelectedRef] = useState('');
  const [tab, setTab] = useState<TemplateTab>('contract');
  const [selectedPath, setSelectedPath] = useState('');
  const [isFeatureOpen, setIsFeatureOpen] = useState(false);

  const activeRef = selectedRef || branches.defaultBranch;
  const tree = useTemplateTree(activeRef);
  const file = useTemplateFile(activeRef, selectedPath);
  const contract = useTemplateContract(activeRef);

  // A branch switch invalidates the open file, which may not exist on the new ref.
  useEffect(() => {
    setSelectedPath('');
  }, [activeRef]);

  const branchNames = useMemo(
    () => [...branches.branches].sort((left, right) =>
      Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name)
    ),
    [branches.branches]
  );
  const entries = tree.result?.entries ?? [];

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-neutral-800/70 pb-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Text as="h1" className="block text-2xl font-semibold tracking-[-.02em] text-neutral-50">
              Project Template
            </Text>
            <Text className="mt-1 block truncate text-sm text-neutral-500">
              What {projectTemplateRepository} requires of every project.
            </Text>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <a
              className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-100"
              href={`https://github.com/${projectTemplateRepository}`}
              rel="noreferrer"
              target="_blank"
            >
              GitHub <ExternalLink className="size-3.5" />
            </a>
            <Button onPress={() => setIsFeatureOpen(true)} size="sm" variant="primary">
              <Plus className="size-4" />
              New template feature
            </Button>
          </div>
        </div>
      </header>

      <div className="flex shrink-0 flex-col gap-3 border-b border-neutral-800/70 py-4 lg:flex-row lg:items-center lg:justify-between">
        <label className="flex h-10 min-w-0 items-center gap-2 rounded-full bg-neutral-900/80 px-3 lg:max-w-xs">
          <GitBranch className="size-3.5 shrink-0 text-neutral-600" />
          <span className="sr-only">Branch</span>
          <select
            aria-label="Branch"
            className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 outline-none"
            disabled={branches.isLoading || branchNames.length === 0}
            onChange={(event) => setSelectedRef(event.currentTarget.value)}
            value={activeRef}
          >
            {branchNames.length === 0 ? <option value={activeRef}>{activeRef}</option> : null}
            {branchNames.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}{branch.isDefault ? ' · default' : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="flex min-w-0 items-center gap-1">
          {(['contract', 'files', ...(projectCheck ? ['project check' as const] : [])] as const).map((id) => (
            <Button
              aria-pressed={tab === id}
              className="shrink-0 rounded-full capitalize"
              key={id}
              onPress={() => setTab(id)}
              size="sm"
              variant={tab === id ? 'secondary' : 'ghost'}
            >
              {id}
            </Button>
          ))}
          <Button
            aria-label="Reload the template contract"
            className="ml-1 size-8 shrink-0 rounded-full px-0"
            isIconOnly
            onPress={() => void contract.reload()}
            size="sm"
            variant="ghost"
          >
            <RefreshCw className={cn('size-3.5', contract.isLoading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {branches.error ? (
        <div
          className="mt-3 shrink-0 rounded-xl border border-amber-500/25 bg-amber-500/[.07] px-4 py-3"
          role="alert"
        >
          <Text className="block text-xs text-amber-200">{branches.error}</Text>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-4">
        {tab === 'project check' ? (
          projectCheck
        ) : tab === 'contract' ? (
          <TemplateContractView contract={contract.contract} isLoading={contract.isLoading} />
        ) : (
          <TemplateFileExplorer
            entries={entries}
            fileContent={file.content}
            fileMessage={file.message}
            isLoadingFile={file.isLoading}
            isLoadingTree={tree.isLoading}
            onSelectPath={setSelectedPath}
            selectedPath={selectedPath}
            treeError={tree.error}
            truncated={tree.result?.truncated === true}
          />
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-neutral-800/70 py-3 text-xs text-neutral-600">
        <span>{projectTemplateRepository} · {activeRef}</span>
        <span>
          {entries.filter((entry) => entry.type === 'blob').length} files
          {contract.contract.modules.length > 0
            ? ` · ${contract.contract.modules.length} ${contract.contract.modules.length === 1 ? 'module' : 'modules'}`
            : ''}
        </span>
      </footer>

      {isFeatureOpen ? (
        <TemplateFeatureDialog
          branch={activeRef}
          contextPath={selectedPath || undefined}
          onClose={() => setIsFeatureOpen(false)}
        />
      ) : null}
    </section>
  );
}
