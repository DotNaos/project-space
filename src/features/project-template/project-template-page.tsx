import { useEffect, useState, type ReactNode } from 'react';
import { ExternalLink, FileText, LayoutList, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import { projectTemplateRepository } from './template-contract-model';
import { TemplateBranchPicker } from './template-branch-picker';
import { TemplateContractSummary, TemplateContractView } from './template-contract-view';
import { TemplateFeatureDialog } from './template-feature-dialog';
import { TemplateFileExplorer } from './template-file-explorer';
import {
  useTemplateBranches,
  useTemplateContract,
  useTemplateFile,
  useTemplateTree
} from './use-template-repository';

type TemplateTab = 'check' | 'contract' | 'files';

const tabs: Array<{ icon: typeof LayoutList; id: TemplateTab; label: string }> = [
  { icon: LayoutList, id: 'contract', label: 'Contract' },
  { icon: FileText, id: 'files', label: 'Files' },
  { icon: ShieldCheck, id: 'check', label: 'Project check' }
];

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

  const entries = tree.result?.entries ?? [];
  const visibleTabs = tabs.filter((entry) => entry.id !== 'check' || Boolean(projectCheck));

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <Text as="h1" className="shrink-0 text-2xl font-semibold tracking-[-.02em] text-neutral-50">
            Project Template
          </Text>
          <TemplateBranchPicker
            branches={branches.branches}
            isDisabled={branches.isLoading || branches.branches.length === 0}
            onSelect={setSelectedRef}
            selected={activeRef}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <a
            className="inline-flex size-9 items-center justify-center rounded-full text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-200"
            href={`https://github.com/${projectTemplateRepository}`}
            rel="noreferrer"
            target="_blank"
            title={`Open ${projectTemplateRepository} on GitHub`}
          >
            <ExternalLink className="size-4" />
          </a>
          <Button
            aria-label="Reload the template contract"
            className="size-9 rounded-full px-0"
            isIconOnly
            onPress={() => void contract.reload()}
            size="sm"
            variant="ghost"
          >
            <RefreshCw className={cn('size-4', contract.isLoading && 'animate-spin')} />
          </Button>
          <Button className="ml-1" onPress={() => setIsFeatureOpen(true)} size="sm" variant="primary">
            <Plus className="size-4" />
            New template feature
          </Button>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-neutral-800/70 pb-3">
        <div className="flex min-w-0 items-center gap-1">
          {visibleTabs.map(({ icon: Icon, id, label }) => (
            <Button
              aria-pressed={tab === id}
              className="shrink-0 rounded-full"
              key={id}
              onPress={() => setTab(id)}
              size="sm"
              variant={tab === id ? 'secondary' : 'ghost'}
            >
              <Icon className="size-3.5" />
              {label}
            </Button>
          ))}
        </div>
        <TemplateContractSummary contract={contract.contract} />
      </div>

      {branches.error ? (
        <div
          className="mt-3 shrink-0 rounded-xl border border-amber-500/25 bg-amber-500/[.07] px-4 py-2.5"
          role="alert"
        >
          <Text className="block text-xs text-amber-200">{branches.error}</Text>
        </div>
      ) : null}

      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col pt-4',
          tab === 'check' ? 'overflow-y-auto' : 'overflow-hidden'
        )}
      >
        {tab === 'check' ? (
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

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-neutral-800/70 py-2.5 text-[11px] text-neutral-700">
        <span className="truncate">{projectTemplateRepository} · {activeRef}</span>
        <span>{entries.filter((entry) => entry.type === 'blob').length} files</span>
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
