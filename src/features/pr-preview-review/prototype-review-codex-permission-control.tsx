import { useState } from 'react';
import { Popover } from '@heroui/react';
import { Check, Loader2, ShieldAlert } from 'lucide-react';

import type { CodexSessionPermissionProfile } from '@/shared/codex-sessions-api';

export function PrototypeReviewCodexPermissionControl({
  activeProfileId,
  disabled,
  isDark,
  onChange,
  profiles
}: {
  activeProfileId?: string;
  disabled?: boolean;
  isDark: boolean;
  onChange(profileId: string): Promise<void>;
  profiles: readonly CodexSessionPermissionProfile[];
}) {
  const [changing, setChanging] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const activeLabel = profileLabel(activeProfileId);

  async function select(profile: CodexSessionPermissionProfile) {
    if (!profile.allowed || profile.id === activeProfileId || changing) return;
    if (isFullAccess(profile.id) && confirming !== profile.id) {
      setConfirming(profile.id);
      return;
    }
    setChanging(profile.id);
    setError(undefined);
    try {
      await onChange(profile.id);
      setConfirming(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not change permissions.');
    } finally {
      setChanging(undefined);
    }
  }

  return (
    <Popover>
      <Popover.Trigger
        aria-disabled={disabled}
        aria-label={`Change permissions${activeLabel ? `, currently ${activeLabel}` : ''}`}
        className={`grid size-9 shrink-0 cursor-pointer place-items-center rounded-full outline-none transition focus-visible:ring-2 disabled:cursor-default disabled:opacity-40 ${
          disabled ? 'pointer-events-none opacity-40' : ''
        } ${
          activeProfileId
            ? 'text-amber-500'
            : isDark
              ? 'text-neutral-400'
              : 'text-neutral-500'
        } ${
          isDark
            ? 'hover:bg-neutral-700/80 hover:text-neutral-100 focus-visible:ring-neutral-600'
            : 'hover:bg-white hover:text-neutral-900 focus-visible:ring-neutral-300'
        }`}
        title="Change permissions"
      >
        {changing ? (
          <Loader2 className="size-[1.125rem] animate-spin" />
        ) : (
          <ShieldAlert className="size-[1.125rem]" />
        )}
      </Popover.Trigger>
      <Popover.Content
        className={`w-72 rounded-2xl border p-2 shadow-2xl backdrop-blur-xl ${
          isDark
            ? 'border-neutral-700 bg-neutral-900/96 text-neutral-100 shadow-black/60'
            : 'border-stone-200 bg-white/96 text-neutral-900 shadow-black/20'
        }`}
        offset={8}
        placement="top"
      >
        <Popover.Dialog className="outline-none">
          <div className="px-2 pb-2 pt-1">
            <p className="text-sm font-semibold">Permissions</p>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              Applies to following turns in this local Codex task.
            </p>
          </div>
          {profiles.length ? (
            <div className="space-y-0.5">
              {profiles.map((profile) => {
                const selected = profile.id === activeProfileId;
                const needsConfirmation =
                  isFullAccess(profile.id) && confirming === profile.id;
                return (
                  <button
                    className={`flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition disabled:cursor-default disabled:opacity-40 ${
                      isDark ? 'hover:bg-neutral-800' : 'hover:bg-stone-100'
                    }`}
                    disabled={!profile.allowed || Boolean(changing)}
                    key={profile.id}
                    onClick={() => void select(profile)}
                    type="button"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold">
                        {needsConfirmation ? 'Confirm full access' : profileLabel(profile.id)}
                      </span>
                      <span className="mt-0.5 block text-[10px] leading-4 text-neutral-500">
                        {needsConfirmation
                          ? 'This lets Codex work without the normal workspace boundary.'
                          : profile.description ?? fallbackDescription(profile.id)}
                      </span>
                    </span>
                    {changing === profile.id ? (
                      <Loader2 className="size-4 shrink-0 animate-spin" />
                    ) : selected ? (
                      <Check className="size-4 shrink-0" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="px-2 py-3 text-xs leading-5 text-neutral-500">
              The local Codex server did not advertise any permission profiles.
            </p>
          )}
          {error ? <p className="px-2 pt-2 text-[11px] text-rose-400">{error}</p> : null}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

function isFullAccess(id: string) {
  return id.toLowerCase().includes('danger') || id.toLowerCase().includes('full-access');
}

function profileLabel(id?: string) {
  if (!id) return undefined;
  if (id === ':workspace') return 'Workspace';
  if (id === ':read-only') return 'Read only';
  if (isFullAccess(id)) return 'Full access';
  return id.replace(/^:/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => (
    letter.toUpperCase()
  ));
}

function fallbackDescription(id: string) {
  if (id === ':workspace') return 'Read and change files inside the current workspace.';
  if (id === ':read-only') return 'Inspect files without changing the workspace.';
  if (isFullAccess(id)) return 'Unrestricted local machine access.';
  return 'Permission profile supplied by the local Codex server.';
}
