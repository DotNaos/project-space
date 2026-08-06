import { useState } from "react";
import { Button } from "@heroui/react";
import {
  ArrowLeft,
  Box,
  Cable,
  CircleGauge,
  FolderGit2,
  HardDrive,
  Monitor,
  Network,
  Power,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";

import { PageFilter, PageStatus, SectionHeading } from "./page-foundation";

export interface PrototypeMachine {
  detail: string;
  load: string;
  name: string;
  role: string;
  status: "Online" | "Sleeping";
  tasks: string;
}

const connectors = [
  { channel: "Stable", lastSeen: "now", name: "Local connector", status: "Connected" },
  { channel: "Dev", lastSeen: "4 min", name: "Codex runtime", status: "Connected" },
];

const projects = [
  { branch: "issue-437-redesign-the-project-space-frontend", name: "project-space", state: "Modified" },
  { branch: "main", name: "design-space", state: "Clean" },
  { branch: "main", name: "dotfiles", state: "Clean" },
];

export function MachineDetailView({ machine, onBack }: { machine: PrototypeMachine; onBack(): void }) {
  const [section, setSection] = useState<"Connectors" | "Overview" | "Projects">("Overview");
  const [online, setOnline] = useState(machine.status === "Online");

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col px-5 pb-6 pt-3 @md:px-8 @3xl:px-10 @5xl:px-12 @5xl:pt-7">
      <header className="shrink-0 border-b border-current/[.08] pb-5">
        <div className="flex items-center justify-between gap-3">
          <Button size="sm" style={{ color: "inherit" }} variant="ghost" onPress={onBack}><ArrowLeft className="size-4" /> Machines</Button>
          <div className="flex items-center gap-1">
            <Button size="sm" style={{ color: "inherit" }} variant="ghost"><RefreshCw className="size-3.5" /> Refresh</Button>
            <Button size="sm" variant={online ? "outline" : "primary"} onPress={() => setOnline((value) => !value)}><Power className="size-3.5" /> {online ? "Sleep" : "Wake"}</Button>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-full bg-current/[.06] text-current/50"><Monitor className="size-5" /></span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold tracking-[-.03em]">{machine.name}</h1><PageStatus tone={online ? "success" : "muted"}>{online ? "Online" : "Sleeping"}</PageStatus></div>
            <p className="mt-1 text-xs text-current/35">{machine.role} · {machine.detail}</p>
          </div>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-1 border-b border-current/[.08] py-3">
        {(["Overview", "Projects", "Connectors"] as const).map((item) => <PageFilter active={section === item} key={item} onPress={() => setSection(item)}>{item}</PageFilter>)}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-6 [scrollbar-width:none]">
        {section === "Overview" ? (
          <div className="grid gap-10 @3xl:grid-cols-[minmax(0,1.35fr)_minmax(17rem,.65fr)]">
            <main>
              <SectionHeading>System</SectionHeading>
              <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
                {[
                  { icon: CircleGauge, label: "CPU", value: machine.load },
                  { icon: HardDrive, label: "Memory", value: "11.8 GB" },
                  { icon: Network, label: "Network", value: "Tailscale" },
                  { icon: Box, label: "Runtime", value: "2 tasks" },
                ].map(({ icon: Icon, label, value }) => (
                  <div className="rounded-xl bg-current/[.035] px-3 py-3" key={label}><Icon className="size-3.5 text-current/35" /><span className="mt-3 block text-sm font-semibold">{value}</span><span className="mt-1 block text-[11px] text-current/35">{label}</span></div>
                ))}
              </div>
              <section className="mt-9">
                <SectionHeading>Active work</SectionHeading>
                <div className="border-y border-current/[.08]">
                  {projects.slice(0, 2).map((project) => (
                    <button className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-current/[.06] py-3.5 text-left last:border-0 hover:bg-current/[.025]" key={project.name} type="button">
                      <span className="grid size-8 place-items-center rounded-full bg-current/[.05] text-current/40"><FolderGit2 className="size-4" /></span>
                      <span className="min-w-0"><span className="block text-sm font-medium">{project.name}</span><span className="mt-1 block truncate text-xs text-current/35">{project.branch}</span></span>
                      <PageStatus tone={project.state === "Modified" ? "info" : "success"}>{project.state}</PageStatus>
                    </button>
                  ))}
                </div>
              </section>
            </main>
            <aside>
              <SectionHeading>Connection</SectionHeading>
              <div className="border-y border-current/[.08] py-2">
                {[["Status", online ? "Reachable" : "Unavailable"], ["Last seen", "now"], ["Address", "100.88.24.12"], ["Channel", "Stable"]].map(([label, value]) => <div className="flex items-center justify-between gap-3 py-2.5" key={label}><span className="text-xs text-current/35">{label}</span><span className="text-xs font-medium text-current/65">{value}</span></div>)}
              </div>
              <Button className="mt-4 w-full" variant="secondary"><TerminalSquare className="size-4" /> Open terminal</Button>
            </aside>
          </div>
        ) : null}

        {section === "Projects" ? (
          <div>
            <SectionHeading meta={`${projects.length} checkouts`}>Project checkouts</SectionHeading>
            <div className="border-y border-current/[.08]">
              {projects.map((project) => (
                <button className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 border-b border-current/[.06] py-4 text-left last:border-0 hover:bg-current/[.025]" key={project.name} type="button">
                  <FolderGit2 className="mt-0.5 size-4 text-current/35" />
                  <span className="min-w-0"><span className="block text-sm font-medium">{project.name}</span><span className="mt-1 block truncate text-xs text-current/35">{project.branch}</span></span>
                  <PageStatus tone={project.state === "Modified" ? "info" : "success"}>{project.state}</PageStatus>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {section === "Connectors" ? (
          <div>
            <SectionHeading meta={`${connectors.length} installations`}>Connector installations</SectionHeading>
            <div className="border-y border-current/[.08]">
              {connectors.map((connector) => (
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-current/[.06] py-4 last:border-0" key={connector.name}>
                  <span className="grid size-8 place-items-center rounded-full bg-emerald-500/10 text-emerald-400"><Cable className="size-4" /></span>
                  <span className="min-w-0"><span className="block text-sm font-medium">{connector.name}</span><span className="mt-1 block text-xs text-current/35">{connector.channel} · seen {connector.lastSeen}</span></span>
                  <PageStatus tone="success">{connector.status}</PageStatus>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
