import { Bot, ChevronRight, Circle, Monitor, Search, WifiOff } from 'lucide-react';
import {
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import {
  effectiveCodexSessionStatus,
  formatCodexActivity,
  groupCodexSessions
} from './codex-sessions-model';
import type {
  CodexMachine,
  CodexSession,
  CodexSessionStatus,
  CodexThreadOrigin
} from './codex-sessions-types';

const statusTone: Record<CodexSessionStatus, string> = {
  active: 'text-emerald-400',
  archived: 'text-neutral-600',
  idle: 'text-neutral-400',
  missing: 'text-amber-400',
  offline: 'text-neutral-600',
  unavailable: 'text-red-400'
};

function SessionRow({
  machine,
  onSelect,
  selected,
  session,
  now
}: {
  machine: CodexMachine;
  onSelect(session: CodexSession): void;
  selected: boolean;
  session: CodexSession;
  now: Date;
}) {
  const status = effectiveCodexSessionStatus(session, machine);
  return (
    <button
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'group flex w-full min-w-0 items-start gap-3 border-l-2 px-3 py-3 text-left transition-colors duration-200',
        selected
          ? 'border-neutral-100 bg-neutral-900 text-neutral-100'
          : 'border-transparent text-neutral-300 hover:bg-neutral-900/60 hover:text-neutral-100'
      )}
      onClick={() => onSelect(session)}
      type="button"
    >
      <Bot className="mt-0.5 size-4 shrink-0 text-neutral-500" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <Text className="truncate text-xs font-medium">{session.title}</Text>
          <ChevronRight className="ml-auto size-3 shrink-0 text-neutral-700 group-hover:text-neutral-500" />
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-neutral-500">
          <Circle className={cn('size-1.5 shrink-0 fill-current', statusTone[status])} />
          <span className="capitalize">{status}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{session.projectName ?? session.cwd ?? 'Unknown directory'}</span>
        </span>
        <span className="mt-1 flex items-center gap-1.5 font-mono text-[9px] text-neutral-600">
          <span>{session.model ?? 'Model unavailable'}</span>
          <span aria-hidden>·</span>
          <time dateTime={session.lastActivityAt}>{formatCodexActivity(session.lastActivityAt, now)}</time>
        </span>
      </span>
    </button>
  );
}

export function CodexSessionList({
  machines,
  now,
  onSelect,
  query,
  selectedOrigin,
  sessions,
  setQuery
}: {
  machines: CodexMachine[];
  now: Date;
  onSelect(session: CodexSession): void;
  query: string;
  selectedOrigin?: CodexThreadOrigin;
  sessions: CodexSession[];
  setQuery(value: string): void;
}) {
  const groups = groupCodexSessions(machines, sessions, query);
  const resultCount = groups.reduce(
    (count, group) => count + group.sections.reduce((sum, section) => sum + section.sessions.length, 0),
    0
  );

  return (
    <section aria-label="Codex sessions" className="flex h-full min-h-0 flex-col bg-neutral-950">
      <header className="shrink-0 border-b border-neutral-800/80 px-4 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <Text as="h1" className="text-sm font-semibold text-neutral-100">Codex</Text>
          <Text className="ml-auto text-[10px] text-neutral-500">{sessions.length} sessions</Text>
        </div>
        <SearchField
          aria-label="Search Codex sessions"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900/60"
          onChange={setQuery}
          value={query}
        >
          <SearchFieldGroup>
            <Search className="size-3.5 shrink-0 text-neutral-500" />
            <SearchFieldInput aria-label="Search by title, project, directory, model, or machine" placeholder="Search sessions" />
            <SearchFieldClearButton />
          </SearchFieldGroup>
        </SearchField>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {resultCount === 0 ? (
          <div className="px-5 py-10 text-center">
            {query
              ? <Search className="mx-auto size-5 text-neutral-600" />
              : <Bot className="mx-auto size-5 text-neutral-600" />}
            <Text className="mt-3 block text-xs text-neutral-400">
              {query ? `No sessions match “${query}”.` : 'No Codex sessions are available.'}
            </Text>
          </div>
        ) : groups.map(({ machine, sections }) => (
          <section className="mb-3" key={machine.id}>
            <div className="flex items-center gap-2 px-4 py-2">
              {machine.status === 'offline'
                ? <WifiOff className="size-3.5 text-neutral-600" />
                : <Monitor className="size-3.5 text-neutral-500" />}
              <Text className="truncate text-[11px] font-semibold text-neutral-300">{machine.name}</Text>
              <Text className={cn(
                'ml-auto text-[9px] capitalize',
                machine.status === 'connected' ? 'text-emerald-500' : 'text-neutral-600'
              )}>{machine.status}</Text>
            </div>
            {sections.length === 0 ? (
              <Text className="block px-4 py-3 text-[10px] leading-4 text-neutral-600">
                No sessions reported by this machine.
              </Text>
            ) : sections.map((section) => (
              <div className="mb-2" key={section.id}>
                <Text className="block px-4 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-neutral-600">
                  {section.label}
                </Text>
                {section.sessions.map((session) => (
                  <SessionRow
                    key={`${session.machineId}:${session.threadId}`}
                    machine={machine}
                    now={now}
                    onSelect={onSelect}
                    selected={
                      selectedOrigin?.machineId === session.machineId
                      && selectedOrigin.threadId === session.threadId
                    }
                    session={session}
                  />
                ))}
              </div>
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}
