import { Cloud, ExternalLink, Monitor, RefreshCw, Server, Smartphone } from "lucide-react";

import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import {
  PagePrimaryAction,
  PageScaffold,
  PageState,
  PageStatus,
  SectionHeading,
} from "./page-foundation";

const machines = [
  { icon: Monitor, detail: "Windows 11 · local network", load: "42%", name: "os-pc", role: "Primary development", status: "Online" as const, tasks: "2 tasks" },
  { icon: Smartphone, detail: "Ubuntu · Tailscale", load: "—", name: "os-yoga-unix", role: "Portable development", status: "Sleeping" as const, tasks: "No active work" },
  { icon: Server, detail: "Ubuntu · VPS", load: "18%", name: "project-space-vps", role: "Production runtime", status: "Online" as const, tasks: "v0.4.56" },
];

export function ProjectMachinesPage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const unavailable = scenario === "empty" || scenario === "offline";
  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<RefreshCw className="size-4" />}>Refresh</PagePrimaryAction>}
      description="Development destinations are shared infrastructure, not another project hierarchy."
      projectName={projectName}
      title="Machines"
    >
      <div className="py-6 @5xl:py-8">
        <SectionHeading meta="3 known destinations">Available destinations</SectionHeading>
        {unavailable ? <PageState emptyCopy="Connect a development destination to make it available here." scenario={scenario} /> : (
          <div className="divide-y divide-current/[.07] border-y border-current/[.08]">
            {machines.map((machine) => {
              const Icon = machine.icon;
              return (
                <button
                  className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 py-4 text-left hover:bg-current/[.02] @md:grid-cols-[auto_minmax(0,1fr)_7rem_7rem_auto] @md:items-center @md:gap-4"
                  key={machine.name}
                  type="button"
                >
                  <span className="grid size-9 place-items-center rounded-full bg-current/[.06] text-current/45">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{machine.name}</span>
                    <span className="mt-1 block truncate text-xs text-current/40">{machine.role} · {machine.detail}</span>
                  </span>
                  <span className="hidden @md:block">
                    <span className="block text-[10px] uppercase tracking-wide text-current/25">Current work</span>
                    <span className="mt-1 block text-xs text-current/55">{machine.tasks}</span>
                  </span>
                  <span className="hidden @md:block">
                    <span className="block text-[10px] uppercase tracking-wide text-current/25">Load</span>
                    <span className="mt-1 block text-xs text-current/55">{machine.load}</span>
                  </span>
                  <PageStatus tone={machine.status === "Online" ? "success" : "muted"}>{machine.status}</PageStatus>
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-4 max-w-2xl text-xs leading-5 text-current/35">
          A machine only becomes a project workspace after a worktree is placed on it. Availability and project ownership remain separate.
        </p>
      </div>
    </PageScaffold>
  );
}

const deploymentGroups = [
  {
    title: "Production",
    rows: [
      { commit: "dc6bd8d", detail: "projects.os-home.net", name: "Project Space", status: "Healthy", time: "4h", tone: "success" as const, version: "v0.4.56" },
    ],
  },
  {
    title: "Pull request previews",
    rows: [
      { commit: "72c0f48", detail: "Issue #437 · frontend redesign", name: "Local prototype", status: "Running", time: "now", tone: "info" as const, version: "branch" },
      { commit: "2550cd7", detail: "PR #426 · Preview hub", name: "Preview deployment", status: "Offline", time: "2h", tone: "muted" as const, version: "preview" },
    ],
  },
  {
    title: "Releases",
    rows: [
      { commit: "dc6bd8d", detail: "Signed release · GitHub", name: "Project Space", status: "Published", time: "4h", tone: "success" as const, version: "v0.4.56" },
      { commit: "d07b6ec", detail: "Signed release · GitHub", name: "Project Space", status: "Published", time: "yesterday", tone: "success" as const, version: "v0.4.51" },
    ],
  },
];

export function ProjectDeploymentsPage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const unavailable = scenario === "empty" || scenario === "offline";
  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<ExternalLink className="size-4" />}>Open production</PagePrimaryAction>}
      description="Preview, release, and production stay visibly separate until each step is proven."
      projectName={projectName}
      title="Deployments"
    >
      {unavailable ? <PageState emptyCopy="Deployments will appear after the first preview or release." scenario={scenario} /> : (
        <div className="space-y-8 py-6 @5xl:py-8">
          {deploymentGroups.map((group) => (
            <section key={group.title}>
              <SectionHeading>{group.title}</SectionHeading>
              <div className="divide-y divide-current/[.07] border-y border-current/[.08]">
                {group.rows.map((row) => (
                  <button
                    className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-4 text-left hover:bg-current/[.02] @md:grid-cols-[auto_minmax(0,1fr)_8rem_5rem_auto] @md:gap-4"
                    key={`${row.name}-${row.version}`}
                    type="button"
                  >
                    <span className="grid size-9 place-items-center rounded-full bg-current/[.06] text-current/45">
                      {group.title === "Production" ? <Cloud className="size-4" /> : <Server className="size-4" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{row.name}</span>
                      <span className="mt-1 block truncate text-xs text-current/40">{row.detail}</span>
                    </span>
                    <span className="hidden font-mono text-xs text-current/35 @md:block">{row.commit}</span>
                    <span className="hidden text-xs text-current/30 @md:block">{row.time}</span>
                    <PageStatus tone={row.tone}>{row.status}</PageStatus>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageScaffold>
  );
}
