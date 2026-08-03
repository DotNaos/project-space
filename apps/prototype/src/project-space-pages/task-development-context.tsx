import { Button, Card, Disclosure } from "@heroui/react";
import { Bot, ChevronDown, Circle, Globe, Laptop, LoaderCircle, PanelsTopLeft, Play, Plus, Shapes } from "lucide-react";
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
  const [threadsOpen, setThreadsOpen] = useState(false);
  const workspace = task.workspace;
  const [attachedMachines, setAttachedMachines] = useState<string[]>(workspace ? [workspace.machine] : []);
  const threads = task.agentThreads ?? (task.agentRun ? [{ id: `task-${task.number}`, name: task.agentRun.name, status: task.agentRun.status === "running" ? "running" as const : "idle" as const }] : []);

  if (!workspace || task.pullRequest?.phase !== "ready" || ["merged", "deploying", "deployed"].includes(task.stage)) return null;

  return (
    <section className="mt-5 border-t border-current/[.08] pt-4">
      <div className="flex h-8 items-center justify-between">
        <h2 className="text-xs font-semibold text-current/55">Machines</h2>
        <Button aria-label="Add machine" className="size-8 min-w-8 rounded-full text-current/45" isIconOnly size="sm" variant="ghost" onPress={() => setMachinePickerOpen(true)}>
          <Plus className="size-4" />
        </Button>
      </div>

      <div className="space-y-1.5">
        {attachedMachines.map((machine) => (
          <MachineCard
            expandedMachine={expandedMachine}
            key={machine}
            machine={machine}
            onContinueDevelopment={onContinueDevelopment}
            onExpandedMachineChange={setExpandedMachine}
            onOpenDevServer={onOpenDevServer}
            onOpenPrototype={onOpenPrototype}
            onOpenThread={onOpenThread}
            onThreadsOpenChange={setThreadsOpen}
            threads={threads}
            threadsOpen={threadsOpen && expandedMachine === machine}
          />
        ))}
      </div>

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

function MachineCard({ expandedMachine, machine, onContinueDevelopment, onExpandedMachineChange, onOpenDevServer, onOpenPrototype, onOpenThread, onThreadsOpenChange, threads, threadsOpen }: {
  expandedMachine: string | null;
  machine: string;
  onContinueDevelopment(): void;
  onExpandedMachineChange(machine: string | null): void;
  onOpenDevServer(): void;
  onOpenPrototype(): void;
  onOpenThread(thread: MockTaskAgentThread): void;
  onThreadsOpenChange(open: boolean): void;
  threads: NonNullable<MockTask["agentThreads"]>;
  threadsOpen: boolean;
}) {
  return (
    <Card className="gap-0 overflow-hidden rounded-2xl bg-current/[.045] p-0 shadow-none" variant="transparent">
      <Disclosure isExpanded={expandedMachine === machine} onExpandedChange={(isExpanded) => {
        onExpandedMachineChange(isExpanded ? machine : null);
        if (!isExpanded) onThreadsOpenChange(false);
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
              <MachineAction icon={Globe} label="Dev server" status="Live" statusTone="success"><Button size="sm" variant="tertiary" onPress={onOpenDevServer}>Connect</Button></MachineAction>
              <MachineAction icon={Shapes} label="Prototype" status="Running" statusTone="success"><Button size="sm" variant="tertiary" onPress={onOpenPrototype}>Open</Button></MachineAction>
              <MachineAction icon={PanelsTopLeft} label="Design Space" status="Available" statusTone="success"><a className="inline-flex h-8 items-center rounded-full bg-current/[.055] px-3 text-xs font-medium text-current/60 transition-[background-color,color,scale] hover:bg-current/[.1] hover:text-current active:scale-[.96]" href="http://design-space.localhost:1355/" rel="noreferrer" target="_blank">Open</a></MachineAction>
              <MachineAction icon={Bot} label="Codex threads" status={`${threads.filter((thread) => thread.status === "running").length} active · ${threads.length} total`} statusTone="info"><Button size="sm" variant="tertiary" onPress={() => onThreadsOpenChange(!threadsOpen)}>View<ChevronDown className={`size-3 transition-transform ${threadsOpen ? "rotate-180" : ""}`} /></Button></MachineAction>
              {threadsOpen ? <div className="space-y-1 bg-current/[.018] p-1.5">{threads.map((thread) => <button aria-label={`Open ${thread.name} with dev server`} className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-current/[.045] hover:text-blue-300" key={thread.id} onClick={() => onOpenThread(thread)} type="button"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-current/[.055] text-current/35"><Bot className="size-3.5" /></span><span className="min-w-0 flex-1 truncate text-xs font-medium text-current/60">{thread.name}</span>{thread.status === "running" ? <LoaderCircle aria-label="Running" className="size-3.5 shrink-0 animate-spin text-emerald-300/80" /> : <Circle aria-label="Idle" className="size-2.5 shrink-0 text-current/25" />}</button>)}</div> : null}
              <MachineAction icon={Play} label="Development" status="Ready" statusTone="info"><Button size="sm" variant="tertiary" onPress={onContinueDevelopment}>Continue</Button></MachineAction>
            </div>
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </Card>
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
