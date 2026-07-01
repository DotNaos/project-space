import type {
  GitHubCatalogRepository,
  GitHubCatalogResult,
  GitHubOAuthDeviceStartResult,
  MachineRecord
} from '@/shared/project-space-api';
import {
  Check,
  Copy,
  ExternalLink,
  Github,
  Info,
  Terminal,
  X
} from 'lucide-react';
import {
  Button,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Text,
  Tooltip
} from '@/app/dotnaos-ui';
import {
  formatLastSeen,
  type BranchChipRecord,
  type MatrixRow
} from './project-home-overview-model';

function DetailRow({ label, mono, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[10px] font-medium text-neutral-500">{label}</span>
      <span
        className={[
          'min-w-0 truncate text-right text-neutral-200',
          mono ? 'font-mono text-[11px]' : 'text-xs'
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  );
}

export function MachineDetailsTooltip({
  machine,
  projectCount
}: {
  machine: MachineRecord;
  projectCount: number;
}) {
  const origin =
    machine.connector.origin ?? machine.network.tailscaleIp ?? machine.connector.installCommand;

  return (
    <Tooltip delay={150}>
      <Tooltip.Trigger className="inline-flex">
        <span
          aria-label={`${machine.name} details`}
          className="inline-flex size-5 items-center justify-center rounded-full text-neutral-600 transition hover:text-neutral-300"
        >
          <Info className="size-3.5" strokeWidth={1.8} />
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content className="w-56 space-y-1.5">
        {machine.connector.serviceName ? (
          <DetailRow label="Service" value={machine.connector.serviceName} />
        ) : null}
        <DetailRow label="Status" value={machine.connector.status} />
        <DetailRow label="Projects" value={String(projectCount)} />
        <DetailRow label="Last seen" value={formatLastSeen(machine.connector.lastSeen)} />
        {origin ? <DetailRow label="Origin" mono value={origin} /> : null}
      </Tooltip.Content>
    </Tooltip>
  );
}

export function BranchChips({ branches }: { branches: BranchChipRecord[] }) {
  if (branches.length === 0) {
    return null;
  }

  const visibleBranches = branches.slice(0, 3);
  const hiddenCount = branches.length - visibleBranches.length;

  return (
    <div
      aria-label="Branches"
      className="flex max-w-[17rem] shrink-0 items-center gap-1 overflow-x-auto"
    >
      {visibleBranches.map((branch) => (
        <span
          key={branch.name}
          title={branch.name}
          className={[
            'inline-flex max-w-28 shrink-0 items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium',
            branch.isBase
              ? 'bg-neutral-100 text-neutral-950'
              : 'bg-neutral-800/80 text-neutral-300'
          ].join(' ')}
        >
          {branch.name}
        </span>
      ))}
      {hiddenCount > 0 ? (
        <span
          title={branches.slice(3).map((branch) => branch.name).join(', ')}
          className="inline-flex shrink-0 rounded-full bg-neutral-900 px-2 py-0.5 text-[11px] font-medium text-neutral-500"
        >
          +{hiddenCount}
        </span>
      ) : null}
    </div>
  );
}

export function MainListSearch({
  label,
  onChange,
  placeholder,
  value
}: {
  label: string;
  onChange(value: string): void;
  placeholder: string;
  value: string;
}) {
  return (
    <SearchField aria-label={label} value={value} onChange={onChange}>
      <SearchFieldGroup className="rounded-lg bg-neutral-900/90">
        <SearchFieldSearchIcon />
        <SearchFieldInput className="text-sm" placeholder={placeholder} />
        <SearchFieldClearButton />
      </SearchFieldGroup>
    </SearchField>
  );
}

function projectIdForRow(row: MatrixRow) {
  return row.localMatches[0]?.project.id ?? (row.repo ? `github:${row.repo.fullName}` : '');
}

function GitHubLinkButton({ label, repo }: { label: string; repo: GitHubCatalogRepository }) {
  return (
    <a
      href={repo.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${repo.fullName} on GitHub`}
      onClick={(event) => event.stopPropagation()}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-600 transition hover:bg-neutral-900 hover:text-neutral-200"
      title={label}
    >
      <ExternalLink className="size-3.5" />
    </a>
  );
}

export function ProjectListItem({
  branches,
  layout,
  onSelectProject,
  row
}: {
  branches: BranchChipRecord[];
  layout: 'grid' | 'list';
  onSelectProject(projectId: string): void;
  row: MatrixRow;
}) {
  const projectId = projectIdForRow(row);

  if (layout === 'grid') {
    return (
      <div
        key={row.id}
        className="group flex min-w-0 flex-col gap-4 rounded-lg border border-neutral-900 bg-neutral-950/45 p-4 transition hover:border-neutral-800 hover:bg-neutral-950/70"
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <button
            type="button"
            onClick={() => projectId && onSelectProject(projectId)}
            className="min-w-0 flex-1 text-left"
          >
            <Text className="block min-w-0 truncate text-sm font-semibold text-neutral-100">
              {row.repo?.name ?? row.title}
            </Text>
            <Text className="mt-1 block truncate text-xs text-neutral-500">
              {row.repo?.owner ?? 'Local'}
            </Text>
          </button>
          {row.repo ? <GitHubLinkButton repo={row.repo} label="Open on GitHub" /> : null}
        </div>
        <BranchChips branches={branches} />
      </div>
    );
  }

  return (
    <div
      key={row.id}
      className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-neutral-900/40"
    >
      <button
        type="button"
        onClick={() => projectId && onSelectProject(projectId)}
        className="min-w-0 flex-1 text-left"
      >
        <Text className="block min-w-0 truncate text-sm font-medium text-neutral-100">
          {row.repo?.name ?? row.title}
        </Text>
      </button>
      <BranchChips branches={branches} />
      {row.repo ? <GitHubLinkButton repo={row.repo} label="Open on GitHub" /> : null}
    </div>
  );
}

export function GitHubConnectPanel({
  flow,
  githubCatalog,
  isConnecting,
  onConnect,
  onPoll
}: {
  flow?: GitHubOAuthDeviceStartResult;
  githubCatalog: GitHubCatalogResult;
  isConnecting: boolean;
  onConnect(): void;
  onPoll(): void;
}) {
  if (githubCatalog.status === 'connected') {
    return null;
  }

  return (
    <div className="mb-4 rounded-lg bg-neutral-950/60 px-4 py-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Text className="block text-sm font-semibold text-neutral-100">Connect GitHub</Text>
          <Text className="mt-1 block text-sm text-neutral-500">
            {flow?.status === 'pending'
              ? 'Enter this code on GitHub, then check the login here.'
              : githubCatalog.message ?? 'Connect GitHub to load repositories.'}
          </Text>
        </div>
        {flow?.status === 'pending' ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className="rounded-lg bg-neutral-900 px-3 py-1.5 font-mono text-sm font-semibold text-neutral-100">
              {flow.userCode}
            </span>
            {flow.verificationUri ? (
              <a href={flow.verificationUri} target="_blank" rel="noreferrer">
                <Button size="sm" variant="outline">
                  <ExternalLink className="size-4" />
                  Open GitHub
                </Button>
              </a>
            ) : null}
            <Button size="sm" isDisabled={isConnecting} onPress={onPoll}>
              Check login
            </Button>
          </div>
        ) : (
          <Button
            className="shrink-0"
            size="sm"
            isDisabled={isConnecting || githubCatalog.status === 'not-configured'}
            onPress={onConnect}
          >
            <Github className="size-4" />
            Login with GitHub
          </Button>
        )}
      </div>
    </div>
  );
}

export function AddMachineDialog({
  hasCopiedInstallCommand,
  installCommand,
  installScriptHref,
  onClose,
  onCopy
}: {
  hasCopiedInstallCommand: boolean;
  installCommand: string;
  installScriptHref: string;
  onClose(): void;
  onCopy(): void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/70 p-4 sm:items-center sm:justify-center">
      <div className="w-full max-w-xl rounded-lg border border-neutral-800 bg-neutral-950 p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Text className="block text-base font-semibold text-neutral-100">Add a machine</Text>
            <Text className="mt-1 block text-sm text-neutral-500">
              Run this on the Mac you want to add. It installs the connector and keeps it running.
            </Text>
          </div>
          <Button aria-label="Close add machine" isIconOnly size="sm" variant="ghost" onPress={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="mt-4 rounded-lg bg-black px-3 py-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-neutral-500">
            <Terminal className="size-3.5" />
            macOS arm64
          </div>
          <code className="block whitespace-pre-wrap break-all font-mono text-sm text-neutral-100">
            {installCommand}
          </code>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" onPress={onCopy}>
            {hasCopiedInstallCommand ? <Check className="size-4" /> : <Copy className="size-4" />}
            {hasCopiedInstallCommand ? 'Copied' : 'Copy command'}
          </Button>
          <a href={installScriptHref} target="_blank" rel="noreferrer">
            <Button size="sm" variant="outline">
              <ExternalLink className="size-4" />
              Open script
            </Button>
          </a>
          <a href="/connector" target="_blank" rel="noreferrer">
            <Button size="sm" variant="ghost">
              Install guide
            </Button>
          </a>
        </div>

        <Text className="mt-3 block text-xs text-neutral-600">
          Linux packaging is not published yet. Build from source or run a matching connector binary with PROJECT_CONNECTOR_HUB_URL set to this site.
        </Text>
      </div>
    </div>
  );
}
