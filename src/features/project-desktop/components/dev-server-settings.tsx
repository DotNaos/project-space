import { useEffect, useState, type FormEvent } from 'react';
import { Settings2 } from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import type { MachineMembershipAccess, ProjectRunSettingsRecord } from '@/shared/project-space-api';

function hostsInput(hosts: string[]) {
  return hosts.join(', ');
}

export function DevServerSettings({
  access,
  hasActiveServers,
  isSaving,
  onSave,
  settings
}: {
  access?: MachineMembershipAccess;
  hasActiveServers: boolean;
  isSaving: boolean;
  onSave(settings: Pick<ProjectRunSettingsRecord, 'allowedHosts'>): Promise<void>;
  settings?: ProjectRunSettingsRecord;
}) {
  const [expanded, setExpanded] = useState(false);
  const [allowedHosts, setAllowedHosts] = useState('');
  const savedAllowedHosts = hostsInput(settings?.allowedHosts ?? []);

  useEffect(() => {
    setAllowedHosts(savedAllowedHosts);
  }, [savedAllowedHosts]);

  if ((access !== 'owner' && access !== 'member') || !settings) {
    return null;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await onSave({
        allowedHosts: allowedHosts
          .split(',')
          .map((host) => host.trim())
          .filter(Boolean)
      });
      setExpanded(false);
    } catch {
      // The shared worktree panel keeps the validated API error visible.
    }
  }

  return (
    <div className="border-b border-neutral-800/80 px-1 pb-3">
      <Button
        aria-expanded={expanded}
        size="sm"
        variant="ghost"
        onPress={() => setExpanded((value) => !value)}
        className="px-1.5"
      >
        <Settings2 className="size-3.5" />
        Tailnet access
      </Button>

      {expanded ? (
        <form className="mt-3 grid gap-3" onSubmit={(event) => void submit(event)}>
          <label className="grid gap-1.5">
            <Text className="text-xs font-medium text-neutral-300">Allowed hosts</Text>
            <input
              name="allowedHosts"
              autoComplete="off"
              aria-describedby="allowed-hosts-hint"
              value={allowedHosts}
              onChange={(event) => setAllowedHosts(event.currentTarget.value)}
              className="min-h-9 rounded-lg border border-neutral-700 bg-black/25 px-3 font-mono text-sm text-neutral-100 outline-none transition focus-visible:border-violet-400 focus-visible:ring-2 focus-visible:ring-violet-400/25"
              placeholder="preview.example.com, app.example.com…"
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            <Text id="allowed-hosts-hint" className="text-[11px] text-neutral-500">
              Saved for your account. The Tailscale IP is added automatically.
            </Text>
            <Button
              size="sm"
              variant="primary"
              type="submit"
              isDisabled={isSaving || hasActiveServers}
              className="bg-violet-500 text-white hover:bg-violet-400"
            >
              {isSaving ? 'Saving' : 'Save'}
            </Button>
          </div>
          {hasActiveServers ? (
            <Text className="text-[11px] text-amber-200/80">
              Stop running dev servers before changing these settings.
            </Text>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
