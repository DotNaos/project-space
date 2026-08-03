import { Button, Modal } from "@heroui/react";
import { Check, Laptop, LoaderCircle, Plus, Power } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type MachineState = "online" | "starting" | "stopped";

interface AvailableMachine {
  name: string;
  state: MachineState;
}

const availableMachines: AvailableMachine[] = [
  { name: "os-pc", state: "online" },
  { name: "os-macbook", state: "online" },
  { name: "os-yoga-unix", state: "stopped" },
  { name: "os-studio", state: "stopped" },
];

export function TaskMachinePicker({
  attachedMachines,
  isOpen,
  onAttach,
  onOpenChange,
  portalContainer,
}: {
  attachedMachines: string[];
  isOpen: boolean;
  onAttach(machine: string): void;
  onOpenChange(isOpen: boolean): void;
  portalContainer: HTMLElement | null;
}) {
  const [machines, setMachines] = useState(availableMachines);
  const startTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (startTimer.current !== null) window.clearTimeout(startTimer.current);
  }, []);

  function startMachine(machineName: string) {
    setMachines((current) => current.map((machine) => (
      machine.name === machineName ? { ...machine, state: "starting" } : machine
    )));
    startTimer.current = window.setTimeout(() => {
      setMachines((current) => current.map((machine) => (
        machine.name === machineName ? { ...machine, state: "online" } : machine
      )));
      startTimer.current = null;
    }, 650);
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop
        UNSTABLE_portalContainer={portalContainer ?? undefined}
        className="z-[95] bg-black/75"
        style={{
          height: "var(--device-content-height)",
          overflow: "hidden",
          position: "absolute",
          width: "var(--device-content-width)",
        }}
        variant="blur"
      >
        <Modal.Container className="p-3 @3xl:p-6" placement="bottom" scroll="inside" size="sm">
          <Modal.Dialog className="flex max-h-[min(34rem,calc(var(--device-content-height)_-_1.5rem))] min-h-0 flex-col overflow-hidden bg-[#111] text-neutral-100 ring-1 ring-inset ring-white/10">
            <Modal.CloseTrigger aria-label="Close machine picker" />
            <Modal.Header className="shrink-0 px-5 pb-2 pr-12 pt-5">
              <Modal.Heading className="text-base font-semibold">Add machine</Modal.Heading>
              <p className="mt-1 text-xs leading-5 text-neutral-500">Choose another place to continue development.</p>
            </Modal.Header>
            <Modal.Body className="min-h-0 overflow-y-auto px-3 pb-4 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="space-y-1">
                {machines.map((machine) => {
                  const isAttached = attachedMachines.includes(machine.name);
                  const isStarting = machine.state === "starting";
                  const isOnline = machine.state === "online";

                  return (
                    <div className="flex min-h-14 items-center gap-3 rounded-2xl px-3 py-2 hover:bg-white/[.045]" key={machine.name}>
                      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/[.055] text-neutral-400">
                        <Laptop className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-neutral-200">{machine.name}</span>
                        <span className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                          <span className={`size-1.5 rounded-full ${isOnline ? "bg-emerald-400" : isStarting ? "bg-blue-400" : "bg-neutral-600"}`} />
                          {isOnline ? "Online" : isStarting ? "Starting" : "Stopped"}
                        </span>
                      </span>
                      {isAttached ? (
                        <span className="inline-flex h-8 items-center gap-1.5 px-2 text-xs font-medium text-neutral-500">
                          <Check className="size-3.5" /> Current
                        </span>
                      ) : isOnline ? (
                        <Button size="sm" variant="secondary" onPress={() => {
                          onAttach(machine.name);
                          onOpenChange(false);
                        }}>
                          <Plus className="size-3.5" /> Use
                        </Button>
                      ) : (
                        <Button isDisabled={isStarting} size="sm" variant="secondary" onPress={() => startMachine(machine.name)}>
                          {isStarting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Power className="size-3.5" />}
                          {isStarting ? "Starting" : "Start"}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
