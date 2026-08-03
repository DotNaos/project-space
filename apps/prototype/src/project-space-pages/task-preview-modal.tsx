import { Modal } from "@heroui/react";
import { Check, MonitorPlay, Network, Shapes } from "lucide-react";

import type { MockTask, MockTaskAgentThread } from "./task-model";
import { TaskThreadWorkspace } from "./task-thread-workspace";

export function TaskPreviewModal({
  isOpen,
  onOpenChange,
  portalContainer = null,
  surface,
  task,
  thread,
}: {
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
  portalContainer?: HTMLElement | null;
  surface: "development" | "preview" | "prototype" | "thread";
  task: MockTask;
  thread?: MockTaskAgentThread;
}) {
  if (surface === "thread") {
    return <TaskThreadWorkspace isOpen={isOpen} onOpenChange={onOpenChange} portalContainer={portalContainer} task={task} thread={thread} />;
  }

  const config = {
    development: {
      description: `This is the private Tailscale development server running on ${task.workspace?.machine ?? "the assigned machine"}.`,
      heading: "Development server",
      icon: Network,
    },
    preview: {
      description: "This review surface represents the exact pull request revision.",
      heading: "Preview deployment",
      icon: MonitorPlay,
    },
    prototype: {
      description: "This prototype is the focused interaction model for the task.",
      heading: "Prototype",
      icon: Shapes,
    },
  }[surface];
  const Icon = config.icon;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop
        UNSTABLE_portalContainer={portalContainer ?? undefined}
        className="z-[90] bg-black/75"
        style={portalContainer ? {
          height: "var(--device-content-height)",
          overflow: "hidden",
          position: "absolute",
          width: "var(--device-content-width)",
        } : undefined}
        variant="blur"
      >
        <Modal.Container className="p-3" placement="center" size="lg">
          <Modal.Dialog className="flex max-h-[min(44rem,92dvh)] flex-col overflow-hidden bg-[#111] text-neutral-100 ring-1 ring-inset ring-white/10">
            <Modal.CloseTrigger aria-label={`Close ${config.heading}`} />
            <Modal.Header className="border-b border-white/10 px-5 pb-4 pr-12 pt-5">
              <Modal.Heading className="flex items-center gap-2 text-base font-semibold">
                <Icon className="size-4 text-blue-300" />
                {config.heading}
              </Modal.Heading>
              <p className="mt-1 text-xs text-neutral-500">#{task.number} · {task.pullRequest?.revision}</p>
            </Modal.Header>
            <Modal.Body className="min-h-0 overflow-y-auto p-0">
              <div className="flex min-h-[32rem] flex-col bg-[#090909]">
                <header className="flex h-12 items-center gap-3 border-b border-white/[.07] px-5">
                  <span className="grid size-6 place-items-center rounded-full border border-white/10 text-[9px] font-semibold text-white/60">PS</span>
                  <span className="text-sm font-medium">project-space</span>
                  <span className="ml-auto flex items-center gap-1.5 text-[11px] text-emerald-300"><Check className="size-3.5" /> Verified mock</span>
                </header>
                <main className="grid flex-1 place-items-center px-6 py-12 text-center">
                  <div className="max-w-md">
                    <span className="text-xs text-white/30">Task #{task.number}</span>
                    <h2 className="mt-3 text-2xl font-semibold tracking-[-.03em]">{task.title}</h2>
                    <p className="mt-3 text-sm leading-6 text-white/45">{config.description} It is pinned to revision {task.pullRequest?.revision} and remains mock UI.</p>
                    <div className="mx-auto mt-8 h-1 w-32 overflow-hidden rounded-full bg-white/10">
                      <span className="block h-full w-3/4 rounded-full bg-blue-400" />
                    </div>
                  </div>
                </main>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
