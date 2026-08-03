import { Button, Modal } from "@heroui/react";
import { MonitorPlay, Network, Shapes, ShieldCheck } from "lucide-react";

import type { MockTask, MockTaskAgentThread } from "./task-model";
import { TaskDevelopmentServerFrame } from "./task-development-server-frame";
import { TaskThreadWorkspace } from "./task-thread-workspace";
import { taskPreviewDocument } from "./task-preview-document";

export function TaskPreviewModal({
  isOpen,
  onOpenChange,
  onApprove,
  portalContainer = null,
  surface,
  task,
  thread,
}: {
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
  onApprove?(): void;
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
              {surface === "development" ? (
                <TaskDevelopmentServerFrame className="min-h-[32rem]" task={task} />
              ) : (
                <iframe
                  className="min-h-[32rem] w-full border-0 bg-[#090909]"
                  srcDoc={taskPreviewDocument(task, surface)}
                  title={`${config.heading} for task #${task.number}`}
                />
              )}
            </Modal.Body>
            {surface === "preview" && task.pullRequest?.review !== "approved" && onApprove ? (
              <Modal.Footer className="border-t border-white/10 px-5 py-4">
                <Button className="w-full" variant="primary" onPress={onApprove}>
                  <ShieldCheck className="size-4" /> Approve revision {task.pullRequest?.revision}
                </Button>
              </Modal.Footer>
            ) : null}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
