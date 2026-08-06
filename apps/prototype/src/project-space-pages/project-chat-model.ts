import {
  mockTaskGroup,
  mockTaskStageLabel,
  type MockTask,
} from "./task-model";

export type ProjectChatMachine = "Local" | "os-pc" | "os-yoga-unix";

export interface ProjectChatEntry {
  actor: string;
  body: string;
  id: string;
  issueNumber?: number;
  kind: "agent" | "manager" | "user";
  machine?: ProjectChatMachine;
  state?: "active" | "done" | "needs-you";
  taskNumber?: number;
  time: string;
}

const taskAgents: Record<number, { machine: ProjectChatMachine; name: string }> = {
  395: { machine: "os-yoga-unix", name: "Juno" },
  398: { machine: "os-pc", name: "Calypso" },
  426: { machine: "Local", name: "Nora" },
  434: { machine: "Local", name: "Mira" },
  437: { machine: "Local", name: "Aurora" },
};

function entryState(task: MockTask): ProjectChatEntry["state"] {
  const group = mockTaskGroup(task);
  if (group === "Done") return "done";
  if (group === "Needs you") return "needs-you";
  return "active";
}

export function projectChatAgentEntries(tasks: MockTask[]): ProjectChatEntry[] {
  return tasks.map((task) => {
    const fallback = taskAgents[task.number] ?? {
      machine: "Local" as const,
      name: task.agentRun?.name ?? "Codex",
    };
    const latestEvent = task.events.at(-1);
    const machine = (task.agentRun?.machine as ProjectChatMachine | undefined) ?? fallback.machine;

    return {
      actor: fallback.name,
      body: latestEvent?.detail ?? mockTaskStageLabel(task),
      id: `agent-${task.number}`,
      issueNumber: task.number,
      kind: "agent",
      machine,
      state: entryState(task),
      taskNumber: task.number,
      time: task.updated,
    };
  });
}

export function initialProjectChatEntries(tasks: MockTask[]): ProjectChatEntry[] {
  const agents = projectChatAgentEntries(tasks);
  const byTask = new Map(agents.map((entry) => [entry.taskNumber, entry]));
  const orderedAgents = [437, 398, 426, 395, 434]
    .map((taskNumber) => byTask.get(taskNumber))
    .filter((entry): entry is ProjectChatEntry => Boolean(entry));

  return [
    {
      actor: "Project manager",
      body: "I’m coordinating the active work across project-space. Every Agent update stays connected to its Task, issue, and machine here.",
      id: "manager-1",
      kind: "manager",
      machine: "Local",
      time: "09:32",
    },
    {
      actor: "Oli",
      body: "Keep the project conversation and every Agent run in one timeline.",
      id: "user-1",
      kind: "user",
      time: "09:34",
    },
    ...orderedAgents,
    {
      actor: "Project manager",
      body: "The timeline is current. Calypso and Juno need attention; Aurora is working, and Mira’s delivery is complete.",
      id: "manager-2",
      kind: "manager",
      machine: "Local",
      time: "now",
    },
  ];
}

export function projectChatMachineCounts(entries: ProjectChatEntry[]) {
  return (["Local", "os-pc", "os-yoga-unix"] as const).map((machine) => ({
    count: entries.filter((entry) => entry.kind === "agent" && entry.machine === machine).length,
    machine,
  }));
}
