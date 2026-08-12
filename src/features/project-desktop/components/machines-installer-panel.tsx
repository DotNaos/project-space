import { Check, Copy, Download, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { Button, Chip, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { ConnectorCredentialRecord } from '@/shared/project-space-api';

function formatCredentialTime(value: string) {
  return new Date(value).toLocaleString([], {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short'
  });
}

export function MachinesInstallerPanel({
  credentials,
  credentialListError,
  installCommand,
  installScriptHref,
  installerError,
  isGenerating,
  hasCopied,
  onCopy,
  onGenerate,
  onRefreshCredentials,
  onRevoke,
  revokingCredentialId
}: {
  credentials: readonly ConnectorCredentialRecord[];
  credentialListError: string;
  installCommand: string;
  installScriptHref: string;
  installerError: string;
  isGenerating: boolean;
  hasCopied: boolean;
  onCopy(): void;
  onGenerate(): void;
  onRefreshCredentials(): void;
  onRevoke(credentialId: string): void;
  revokingCredentialId: string;
}) {
  return (
    <div className="shrink-0 border-b border-neutral-800/70 py-4">
      <Text className="block text-sm font-medium text-neutral-200">Add a machine</Text>
      <Text className="mt-1 block text-sm text-neutral-500">
        Run this command on the machine. It installs the pinned managed bundle and then opens
        Project Space approval to create the connector&apos;s protected identity.
      </Text>

      {installCommand ? (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-neutral-900/70 px-3 py-2 font-mono text-xs text-neutral-300">
            {installCommand}
          </code>
          <Button
            aria-label="Copy install command"
            isIconOnly
            size="sm"
            variant="ghost"
            className="size-9 min-w-0 px-0"
            onPress={onCopy}
          >
            {hasCopied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
          </Button>
          <Button size="sm" variant="ghost" isDisabled={isGenerating} onPress={onGenerate}>
            <RefreshCw className={cn('size-3.5', isGenerating && 'animate-spin')} />
            Replace
          </Button>
          <a href={installScriptHref} rel="noreferrer" target="_blank">
            <Button size="sm" variant="ghost">
              <Download className="size-3.5" />
              Script
            </Button>
          </a>
        </div>
      ) : (
        <Button
          className="mt-3"
          size="sm"
          variant="secondary"
          isDisabled={isGenerating}
          onPress={onGenerate}
        >
          {isGenerating ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Generate managed installer
        </Button>
      )}

      {installerError ? (
        <Text className="mt-2 block text-xs text-red-300/80">{installerError}</Text>
      ) : null}

      <div className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <Text className="text-[11px] font-medium uppercase tracking-[.08em] text-neutral-600">
            Installer credentials
          </Text>
          <Button
            aria-label="Refresh connector credentials"
            isIconOnly
            size="sm"
            variant="ghost"
            className="size-7 min-w-0 px-0"
            onPress={onRefreshCredentials}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
        {credentials.length > 0 ? (
          <div className="divide-y divide-neutral-800/50">
            {credentials.slice(0, 10).map((credential) => {
              const detail = credential.status === 'active'
                ? `Last seen ${formatCredentialTime(credential.lastSeenAt ?? credential.createdAt)}`
                : `Expires ${formatCredentialTime(credential.expiresAt)}`;

              return (
                <div key={credential.id} className="flex min-w-0 items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Text className="block truncate text-sm text-neutral-300">
                      {credential.machineId ?? 'Pending enrollment'}
                    </Text>
                    <Text className="block truncate text-[11px] text-neutral-600">{detail}</Text>
                  </div>
                  <Chip size="sm" className="shrink-0 text-neutral-600">
                    {credential.status}
                  </Chip>
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={Boolean(revokingCredentialId)}
                    onPress={() => onRevoke(credential.id)}
                  >
                    {revokingCredentialId === credential.id ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                    Revoke
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <Text className="mt-1 block text-xs text-neutral-600">No connector credentials yet.</Text>
        )}
        {credentials.length > 10 ? (
          <Text className="mt-2 block text-xs text-neutral-600">
            Showing the 10 most relevant of {credentials.length} credentials.
          </Text>
        ) : null}
        {credentialListError ? (
          <Text className="mt-2 block text-xs text-red-300/80">{credentialListError}</Text>
        ) : null}
      </div>
    </div>
  );
}
