import { Button, Card, Disclosure } from "@heroui/react";
import { Bot, ChevronDown, Circle, Globe, Laptop, LoaderCircle, PanelsTopLeft, Play, Shapes } from "lucide-react";
import { useState } from "react";

import type { MockTask } from "./task-model";

export function TaskDevelopmentContext({
  onContinueDevelopment,
  onOpenDevServer,
  onOpenPrototype,
  task,
}: {
  onContinueDevelopment(): void;
  onOpenDevServer(): void;
  onOpenPrototype(): void;
  task: MockTask;
}) {
  const [expandedMachine, setExpandedMachine] = useState<string | null>(null);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const workspace = task.workspace;
  const threads = task.agentThreads ?? (task.agentRun ? [{ id: `task-${task.number}`, name: task.agentRun.name, status: task.agentRun.status === "running" ? "running" as const : "idle" as const }] : []);

  if (!workspace || task.pullRequest?.phase !== "ready" || ["merged", "deploying", "deployed"].includes(task.stage)) return null;

  const machineExpanded = expandedMachine === workspace.machine;

  return (
    <section className="mt-5 border-t border-current/[.08] pt-4">
      <h2 className="text-xs font-semibold text-current/55">Machines</h2>

      <Card className="mt-2 gap-0 overflow-hidden rounded-2xl bg-current/[.035] p-0 shadow-none ring-1 ring-inset ring-current/[.07]" variant="transparent">
        <Disclosure
          isExpanded={machineExpanded}
          onExpandedChange={(isExpanded) => {
            setExpandedMachine(isExpanded ? workspace.machine : null);
            if (!isExpanded) setThreadsOpen(false);
          }}
        >
          <Disclosure.Heading>
            <Button className="h-12 w-full justify-start gap-2.5 rounded-2xl px-3 text-left" slot="trigger" variant="ghost">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-current/[.055] text-current/40">
                <Laptop className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-current/75">{workspace.machine}</span>
                <span className="mt-0.5 block truncate text-[10px] text-current/35">
                  {workspace.devServer?.transport ?? "Workspace"} · {workspace.status === "clean" ? "Clean" : `${workspace.changedFiles} files changed`}
                </span>
              </span>
              <span aria-label="Connected" className="size-2 shrink-0 rounded-full bg-emerald-400" role="img" title="Connected" />
              <Disclosure.Indicator className="text-current/35" />
            </Button>
          </Disclosure.Heading>

          <Disclosure.Content>
            <Disclosure.Body className="px-3 pb-2 pt-0">
              <div className="divide-y divide-current/[.07] border-t border-current/[.07]">
                <MachineAction icon={Globe} label="Dev server" status="Live" statusTone="success">
                  <Button size="sm" variant="tertiary" onPress={onOpenDevServer}>Connect</Button>
                </MachineAction>
                <MachineAction icon={Shapes} label="Prototype" status="Running" statusTone="success">
                  <Button size="sm" variant="tertiary" onPress={onOpenPrototype}>Open</Button>
                </MachineAction>
                <MachineAction icon={PanelsTopLeft} label="Design Space" status="Available" statusTone="success">
                  <a className="inline-flex h-8 items-center rounded-full bg-current/[.055] px-3 text-xs font-medium text-current/60 transition-[background-color,color,scale] hover:bg-current/[.1] hover:text-current active:scale-[.96]" href="http://design-space.localhost:1355/" rel="noreferrer" target="_blank">Open</a>
                </MachineAction>
                <MachineAction icon={Bot} label="Codex threads" status={`${threads.filter((thread) => thread.status === "running").length} active · ${threads.length} total`} statusTone="info">
                  <Button size="sm" variant="tertiary" onPress={() => setThreadsOpen((value) => !value)}>
                    View
                    <ChevronDown className={`size-3 transition-transform ${threadsOpen ? "rotate-180" : ""}`} />
                  </Button>
                </MachineAction>
                {threadsOpen ? (
                  <div className="space-y-1 bg-current/[.018] p-1.5">
                    {threads.map((thread) => (
                      <button className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-current/[.045] hover:text-blue-300" key={thread.id} onClick={onContinueDevelopment} type="button">
                        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-current/[.055] text-current/35"><Bot className="size-3.5" /></span>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-current/60">{thread.name}</span>
                        {thread.status === "running" ? <LoaderCircle aria-label="Running" className="size-3.5 shrink-0 animate-spin text-emerald-300/80" /> : <Circle aria-label="Idle" className="size-2.5 shrink-0 text-current/25" />}
                      </button>
                    ))}
                  </div>
                ) : null}
                <MachineAction icon={Play} label="Development" status="Ready" statusTone="info">
                  <Button size="sm" variant="tertiary" onPress={onContinueDevelopment}>Continue</Button>
                </MachineAction>
              </div>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      </Card>
    </section>
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
