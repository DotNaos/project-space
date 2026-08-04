import { Button, Card, Disclosure } from "@heroui/react";
import { Bot, Circle, ExternalLink, Globe, Laptop, LoaderCircle, PanelsTopLeft, Play, Plus, Shapes } from "lucide-react";
import { useState } from "react";

import type { MockTask, MockTaskAgentThread } from "./task-model";
import { TaskMachinePicker } from "./task-machine-picker";

export function TaskDevelopmentContext({
  onContinueDevelopment,
  onOpenDevServer,
  onOpenPrototype,
  onOpenThread,
  portalContainer,
  task,
}: {
  onContinueDevelopment(): void;
  onOpenDevServer(): void;
  onOpenPrototype(): void;
  onOpenThread(thread: MockTaskAgentThread): void;
  portalContainer: HTMLElement | null;
  task: MockTask;
}) {
  const [expandedMachine, setExpandedMachine] = useState<string | null>(null);
  const [machinePickerOpen, setMachinePickerOpen] = useState(false);
  const workspace = task.workspace;
  const [attachedMachines, setAttachedMachines] = useState<string[]>(workspace ? [workspace.machine] : []);
  const threads = task.agentThreads ?? (task.agentRun ? [{ id: `task-${task.number}`, machine: task.agentRun.machine, name: task.agentRun.name, status: task.agentRun.status === "running" ? "running" as const : "idle" as const }] : []);
  const threadsByMachine = groupThreadsByMachine(threads, task.agentRun?.machine ?? workspace?.machine ?? "Local");

  if (!workspace || !task.pullRequest || ["merged", "deploying", "deployed"].includes(task.stage)) return null;

  return (
    <section className="mt-5 space-y-5 border-t border-current/[.08] pt-4">
      <div className="flex h-8 items-center justify-between">
        <h2 className="text-xs font-semibold text-current/55">Active development</h2>
        <Button aria-label="Add machine" className="size-8 min-w-8 rounded-full text-current/45" isIconOnly size="sm" variant="ghost" onPress={() => setMachinePickerOpen(true)}>
          <Plus className="size-4" />
        </Button>
      </div>

      <div className="space-y-1.5">
        {attachedMachines.map((machine) => (
          <DevelopmentMachine
            expandedMachine={expandedMachine}
            key={machine}
            machine={machine}
            onContinueDevelopment={onContinueDevelopment}
            onExpandedMachineChange={setExpandedMachine}
            onOpenDevServer={onOpenDevServer}
            onOpenPrototype={onOpenPrototype}
          />
        ))}
      </div>

      {threadsByMachine.length > 0 ? (
        <section aria-labelledby="codex-threads-heading">
          <h2 className="mb-2 text-xs font-semibold text-current/55" id="codex-threads-heading">Codex threads</h2>
          <div className="space-y-2">
            {threadsByMachine.map((group) => (
              <ThreadMachineGroup group={group} key={group.machine} onOpenThread={onOpenThread} />
            ))}
          </div>
        </section>
      ) : null}

      <TaskMachinePicker
        attachedMachines={attachedMachines}
        isOpen={machinePickerOpen}
        onAttach={(machine) => setAttachedMachines((current) => current.includes(machine) ? current : [...current, machine])}
        onOpenChange={setMachinePickerOpen}
        portalContainer={portalContainer}
      />
    </section>
  );
}

function DevelopmentMachine({ expandedMachine, machine, onContinueDevelopment, onExpandedMachineChange, onOpenDevServer, onOpenPrototype }: {
  expandedMachine: string | null;
  machine: string;
  onContinueDevelopment(): void;
  onExpandedMachineChange(machine: string | null): void;
  onOpenDevServer(): void;
  onOpenPrototype(): void;
}) {
  return (
    <Card className="gap-0 overflow-hidden rounded-2xl bg-current/[.045] p-0 shadow-none" variant="transparent">
      <Disclosure isExpanded={expandedMachine === machine} onExpandedChange={(isExpanded) => {
        onExpandedMachineChange(isExpanded ? machine : null);
      }}>
        <Disclosure.Heading>
          <Button className="h-11 w-full justify-start gap-2.5 rounded-2xl px-3 text-left" slot="trigger" variant="ghost">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-current/[.055] text-current/40"><Laptop className="size-3.5" /></span>
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-current/75">{machine}</span>
            <span aria-label="Connected" className="size-2 shrink-0 rounded-full bg-emerald-400" role="img" title="Connected" />
            <Disclosure.Indicator className="text-current/35" />
          </Button>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="px-3 pb-2 pt-0">
            <div className="divide-y divide-current/[.07]">
              <DevServerBundle
                onOpenDevServer={onOpenDevServer}
                onOpenPrototype={onOpenPrototype}
              />
              <MachineAction icon={Play} label="Development" status="Ready" statusTone="info"><Button size="sm" variant="tertiary" onPress={onContinueDevelopment}>Continue</Button></MachineAction>
            </div>
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </Card>
  );
}

function groupThreadsByMachine(threads: MockTaskAgentThread[], fallbackMachine: string) {
  const groups = new Map<string, MockTaskAgentThread[]>();
  for (const thread of threads) {
    const machine = thread.machine ?? fallbackMachine;
    groups.set(machine, [...(groups.get(machine) ?? []), thread]);
  }
  return [...groups].map(([machine, machineThreads]) => ({ machine, threads: machineThreads }));
}

function ThreadMachineGroup({ group, onOpenThread }: {
  group: { machine: string; threads: MockTaskAgentThread[] };
  onOpenThread(thread: MockTaskAgentThread): void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl bg-current/[.035]">
      <div className="flex h-9 items-center gap-2 px-3 text-current/45">
        <Laptop className="size-3.5" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{group.machine}</span>
        <span className="text-[10px] tabular-nums">{group.threads.length}</span>
      </div>
      <div className="divide-y divide-current/[.06] px-1.5 pb-1.5">
        {group.threads.map((thread) => (
          <button
            aria-label={`Open ${thread.name} on ${group.machine}`}
            className="flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-current/[.045] hover:text-blue-300"
            key={thread.id}
            onClick={() => onOpenThread(thread)}
            type="button"
          >
            <Bot className="size-3.5 shrink-0 text-current/30" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-current/60">{thread.name}</span>
            {thread.status === "running" ? <LoaderCircle aria-label="Running" className="size-3.5 shrink-0 animate-spin text-emerald-300/80" /> : <Circle aria-label="Idle" className="size-2.5 shrink-0 text-current/25" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function DevServerBundle({ onOpenDevServer, onOpenPrototype }: {
  onOpenDevServer(): void;
  onOpenPrototype(): void;
}) {
  return (
    <div className="py-1.5" data-testid="dev-server-bundle">
      <div className="flex min-h-10 items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Globe className="size-3.5 shrink-0 text-current/30" />
          <span className="truncate text-xs font-medium text-current/60">Dev server</span>
          <span aria-label="Live" className="size-1.5 shrink-0 rounded-full bg-emerald-400" role="img" title="Live" />
        </span>
        <Button size="sm" variant="tertiary" onPress={onOpenDevServer}>Connect</Button>
      </div>
      <div className="ml-5 grid gap-0.5 border-l border-current/[.08] pl-3">
        <Button
          aria-label="Open Prototype from Dev server"
          className="h-8 w-full justify-between rounded-lg px-2.5 text-current/45 hover:bg-current/[.03] hover:text-current/70"
          size="sm"
          variant="ghost"
          onPress={onOpenPrototype}
        >
          <span className="flex items-center gap-2 text-[11px]"><Shapes className="size-3.5" /> Prototype</span>
          <ExternalLink aria-hidden="true" className="size-3" />
        </Button>
        <a
          aria-label="Open Design Space from Dev server"
          className="flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-[11px] font-medium text-current/45 transition-[background-color,color,scale] hover:bg-current/[.03] hover:text-current/70 active:scale-[.98]"
          href="http://design-space.localhost:1355/"
          rel="noreferrer"
          target="_blank"
        >
          <span className="flex items-center gap-2"><PanelsTopLeft className="size-3.5" /> Design Space</span>
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      </div>
    </div>
  );
}

function MachineAction({ children, icon: Icon, label, status, statusTone = "muted" }: { children: React.ReactNode; icon: typeof Globe; label: string; status: string; statusTone?: "info" | "muted" | "success" }) {
  return (
    <div className="flex min-h-11 items-center gap-3 py-1.5">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-current/30" />
        <span className="truncate text-xs font-medium text-current/60">{label}</span>
        <span aria-label={status} className={`size-1.5 shrink-0 rounded-full ${statusTone === "success" ? "bg-emerald-400" : statusTone === "info" ? "bg-blue-400" : "bg-current/30"}`} role="img" title={status} />
      </span>
      <span className="shrink-0">{children}</span>
    </div>
  );
}
