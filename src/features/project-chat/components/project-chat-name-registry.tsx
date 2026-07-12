import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, LockKeyhole, X } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import {
  projectChatNameRequiresParent,
  type ProjectChatAgentAvatarCategory
} from '../project-chat-agent-avatar';
import { ProjectChatAgentAvatar } from './project-chat-agent-avatar';

export type ProjectChatNameStatus = 'available' | 'claimed' | 'reserved';

export interface ProjectChatNameRegistryEntry {
  category: ProjectChatAgentAvatarCategory | 'scientist';
  claimedByDisplayName?: string;
  claimedByThreadId?: string;
  name: string;
  status: ProjectChatNameStatus;
}

export interface ProjectChatNameParentThread {
  displayName: string;
  threadId: string;
}

const groups: Array<{
  category: ProjectChatAgentAvatarCategory;
  description: string;
  label: string;
}> = [
  { category: 'mythology', description: 'Durable main and thread agents', label: 'Main agents' },
  { category: 'artist', description: 'Visual design, product, and interaction work', label: 'UI / design' },
  { category: 'science', description: 'Engineering, systems, data, and logic', label: 'Engineering / logic' },
  { category: 'detective', description: 'Testing, review, and acceptance checks', label: 'Review / QA' }
];

function normalizedCategory(category: ProjectChatNameRegistryEntry['category']) {
  return category === 'scientist' ? 'science' : category;
}

function entryStatus(entry: ProjectChatNameRegistryEntry, allowedCategory?: ProjectChatAgentAvatarCategory) {
  if (entry.status === 'reserved') return 'Reserved';
  if (entry.status === 'claimed') {
    return entry.claimedByDisplayName
      ? `Claimed by ${entry.claimedByDisplayName}`
      : entry.claimedByThreadId
        ? `Claimed by thread ${entry.claimedByThreadId}`
        : 'Claimed';
  }
  if (allowedCategory && normalizedCategory(entry.category) !== allowedCategory) {
    return 'Different role';
  }
  return 'Available';
}

export function ProjectChatNameRegistry({
  allowedCategory,
  entries,
  onClaim,
  onClose,
  open,
  parentThreads = []
}: {
  allowedCategory?: ProjectChatAgentAvatarCategory;
  entries: ProjectChatNameRegistryEntry[];
  onClaim?(entry: ProjectChatNameRegistryEntry, parentThreadId?: string): Promise<void>;
  onClose(): void;
  open: boolean;
  parentThreads?: ProjectChatNameParentThread[];
}) {
  const availableEntry = entries.find((entry) => (
    entry.status === 'available'
    && (!allowedCategory || normalizedCategory(entry.category) === allowedCategory)
  ));
  const [focusedName, setFocusedName] = useState('');
  const [claimingName, setClaimingName] = useState('');
  const [error, setError] = useState('');
  const [parentThreadId, setParentThreadId] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const focused = entries.find((entry) => entry.name === focusedName) ?? availableEntry ?? entries[0];
  const groupedEntries = useMemo(() => groups.map((group) => ({
    ...group,
    entries: entries.filter((entry) => normalizedCategory(entry.category) === group.category)
  })), [entries]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setFocusedName(availableEntry?.name ?? entries[0]?.name ?? '');
    setClaimingName('');
    setError('');
    setParentThreadId(parentThreads[0]?.threadId ?? '');
    const frame = requestAnimationFrame(() => dialogRef.current?.focus());
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !claimingName) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function claim(entry: ProjectChatNameRegistryEntry) {
    if (!onClaim) return;
    const parent = projectChatNameRequiresParent(entry.category)
      ? parentThreadId.trim()
      : undefined;
    if (projectChatNameRequiresParent(entry.category) && !parent) {
      setError('Choose the main agent thread this specialist belongs to.');
      return;
    }
    setError('');
    setClaimingName(entry.name);
    try {
      await onClaim(entry, parent);
      onClose();
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : 'This name could not be claimed.');
    } finally {
      setClaimingName('');
    }
  }

  const focusedCategory = focused ? normalizedCategory(focused.category) : undefined;
  const canClaimFocused = Boolean(
    focused
    && focused.status === 'available'
    && (!allowedCategory || focusedCategory === allowedCategory)
    && onClaim
    && (!projectChatNameRequiresParent(focused.category) || parentThreadId.trim())
  );

  return createPortal(
    <div
      aria-describedby="project-chat-name-registry-description"
      aria-labelledby="project-chat-name-registry-title"
      aria-modal="true"
      className="fixed inset-0 z-[80]"
      onKeyDown={handleKeyDown}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <button aria-hidden="true" className="absolute inset-0 bg-black/70" onClick={onClose} tabIndex={-1} type="button" />
      <section className="absolute inset-x-0 bottom-0 flex max-h-[calc(100dvh-1rem)] flex-col rounded-t-2xl border-t border-neutral-800 bg-neutral-950 shadow-2xl shadow-black min-[760px]:inset-y-0 min-[760px]:right-0 min-[760px]:left-auto min-[760px]:w-[min(44rem,94vw)] min-[760px]:rounded-none min-[760px]:border-l min-[760px]:border-t-0">
        <header className="flex shrink-0 items-start gap-3 border-b border-neutral-800 px-5 py-4">
          <div className="min-w-0 flex-1">
            <Text as="h2" className="block text-sm font-semibold text-neutral-100" id="project-chat-name-registry-title">Agent names</Text>
            <Text className="mt-1 block text-xs leading-5 text-neutral-400" id="project-chat-name-registry-description">
              Pattern shows the role group. Color comes from the name and stays stable.
            </Text>
          </div>
          <Button aria-label="Close agent names" className="size-9 min-h-0" isDisabled={Boolean(claimingName)} isIconOnly onPress={onClose} size="sm" variant="ghost">
            <X className="size-4" />
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 min-[760px]:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="min-h-0 overflow-y-auto px-5 py-3">
            {groupedEntries.map((group) => group.entries.length ? (
              <section className="border-b border-neutral-900 py-4 last:border-b-0" key={group.category}>
                <div className="flex items-baseline gap-2">
                  <Text as="h3" className="text-[11px] font-semibold text-neutral-200">{group.label}</Text>
                  <Text className="truncate text-[10px] text-neutral-500">{group.description}</Text>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-px min-[430px]:grid-cols-2" role="listbox" aria-label={group.label}>
                  {group.entries.map((entry) => {
                    const category = normalizedCategory(entry.category);
                    const wrongRole = Boolean(allowedCategory && category !== allowedCategory);
                    const unavailable = entry.status !== 'available' || wrongRole;
                    const selected = focused?.name === entry.name;
                    return (
                      <button
                        aria-disabled={unavailable}
                        aria-selected={selected}
                        className="group flex min-h-14 items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-900 aria-selected:bg-neutral-900"
                        key={entry.name}
                        onClick={() => setFocusedName(entry.name)}
                        role="option"
                        type="button"
                      >
                        <ProjectChatAgentAvatar category={category} name={entry.name} size={38} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold text-neutral-200">{entry.name}</span>
                          <span className={`mt-0.5 block truncate text-[10px] ${unavailable ? 'text-neutral-500' : 'text-emerald-400/80'}`}>
                            {entryStatus(entry, allowedCategory)}
                          </span>
                        </span>
                        {entry.status === 'reserved' ? <LockKeyhole className="size-3.5 text-neutral-600" /> : null}
                        {entry.status === 'claimed' ? <Check className="size-3.5 text-neutral-600" /> : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null)}
          </div>

          <aside className="flex shrink-0 flex-wrap items-center gap-4 border-t border-neutral-800 px-5 py-4 min-[760px]:flex-col min-[760px]:flex-nowrap min-[760px]:justify-center min-[760px]:border-l min-[760px]:border-t-0 min-[760px]:text-center">
            {focused && focusedCategory ? (
              <>
                <ProjectChatAgentAvatar category={focusedCategory} name={focused.name} size={112} />
                <div className="min-w-0 flex-1 min-[760px]:flex-none">
                  <Text className="block truncate text-lg font-semibold text-neutral-100">{focused.name}</Text>
                  <Text className="mt-1 block text-[11px] capitalize text-neutral-400">{focusedCategory}</Text>
                  <Text className="mt-1 block text-[10px] text-neutral-500">{entryStatus(focused, allowedCategory)}</Text>
                </div>
                {projectChatNameRequiresParent(focused.category) && onClaim ? (
                  <div className="min-w-0 basis-full min-[760px]:w-full min-[760px]:flex-none min-[760px]:text-left">
                    <label className="block text-[10px] font-medium text-neutral-300" htmlFor="project-chat-parent-thread">
                      Main agent thread
                    </label>
                    <input
                      autoComplete="off"
                      className="mt-1 h-9 w-full min-w-0 rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 font-mono text-[10px] text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
                      disabled={Boolean(claimingName)}
                      id="project-chat-parent-thread"
                      list="project-chat-parent-threads"
                      onChange={(event) => {
                        setParentThreadId(event.currentTarget.value);
                        setError('');
                      }}
                      placeholder="Exact parent thread ID"
                      required
                      value={parentThreadId}
                    />
                    <datalist id="project-chat-parent-threads">
                      {parentThreads.map((thread) => (
                        <option key={thread.threadId} value={thread.threadId}>{thread.displayName}</option>
                      ))}
                    </datalist>
                    <Text className="mt-1 block text-[9px] leading-4 text-neutral-500">
                      Select a known mythology agent or enter its exact thread ID.
                    </Text>
                  </div>
                ) : null}
                <Button
                  className="ml-auto shrink-0 min-[760px]:mt-2 min-[760px]:ml-0"
                  isDisabled={!canClaimFocused || Boolean(claimingName)}
                  onPress={() => void claim(focused)}
                  size="sm"
                  variant="primary"
                >
                  {claimingName === focused.name ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Claim name
                </Button>
              </>
            ) : <Text className="text-xs text-neutral-400">No names are configured.</Text>}
          </aside>
        </div>
        {error ? <div aria-live="assertive" className="border-t border-red-400/20 px-5 py-3 text-xs text-red-200" role="alert">{error}</div> : null}
      </section>
    </div>,
    document.body
  );
}
