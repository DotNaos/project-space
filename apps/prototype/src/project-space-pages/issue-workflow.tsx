import { useState, type ReactNode } from "react";
import { Button } from "@heroui/react";
import {
  Check,
  CircleDot,
  Download,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Monitor,
  MonitorPlay,
  Play,
  Rocket,
} from "lucide-react";

import type { PrototypeIssue } from "./issue-fixtures";
import { prototypePullRequestLabel } from "./issue-fixtures";
import { PageStatus, SectionHeading } from "./page-foundation";

function StepTitle({ complete, number, title }: { complete?: boolean; number: number; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`grid size-5 place-items-center rounded-full text-[10px] font-semibold ${
        complete ? "bg-emerald-500/15 text-emerald-400" : "bg-current/[.06] text-current/40"
      }`}>
        {complete ? <Check className="size-3" strokeWidth={2.5} /> : number}
      </span>
      <h3 className="text-xs font-medium text-current/70">{title}</h3>
    </div>
  );
}

function WorkflowSection({ children, complete, number, title }: {
  children: ReactNode;
  complete?: boolean;
  number: number;
  title: string;
}) {
  return (
    <section className="border-b border-current/[.06] py-4 last:border-0">
      <StepTitle complete={complete} number={number} title={title} />
      <div className="mt-3 pl-7">{children}</div>
    </section>
  );
}

function DevelopmentLink({ children, href, tone = "blue" }: {
  children: ReactNode;
  href: string;
  tone?: "blue" | "violet";
}) {
  return (
    <a
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition hover:brightness-125 ${
        tone === "violet"
          ? "bg-violet-500/12 text-violet-300"
          : "bg-blue-500/12 text-blue-300"
      }`}
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      <span className="truncate">{children}</span>
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}

export function IssueWorkflow({ issue }: { issue: PrototypeIssue }) {
  const [draftPullRequest, setDraftPullRequest] = useState(false);
  const [prototypeRunning, setPrototypeRunning] = useState(Boolean(issue.preview));
  const [previewRunning, setPreviewRunning] = useState(Boolean(issue.pullRequest));
  const [testsPassed, setTestsPassed] = useState(issue.state === "Done");
  const [destination, setDestination] = useState<string | null>(null);
  const [issueState, setIssueState] = useState<"Open" | "Closed">(issue.state === "Done" ? "Closed" : "Open");
  const issueUrl = `https://github.com/DotNaos/project-space/issues/${issue.number}`;

  return (
    <aside className="min-w-0">
      <SectionHeading>Development workflow</SectionHeading>
      <div className="border-y border-current/[.08]">
        <WorkflowSection complete={Boolean(issue.branch)} number={1} title="Branch">
          {issue.branch ? (
            <DevelopmentLink href={`https://github.com/DotNaos/project-space/tree/${issue.branch}`}>
              <GitBranch className="size-3.5 shrink-0" />
              {issue.branch}
            </DevelopmentLink>
          ) : (
            <Button size="sm" variant="secondary"><GitBranch className="size-3.5" /> Create linked branch</Button>
          )}
        </WorkflowSection>

        <WorkflowSection complete={Boolean(issue.pullRequest || draftPullRequest)} number={2} title="Pull request">
          {issue.pullRequest ? (
            <DevelopmentLink href={issue.pullRequest.url} tone="violet">
              <GitPullRequest className="size-3.5 shrink-0" />
              {prototypePullRequestLabel(issue.pullRequest)}
            </DevelopmentLink>
          ) : draftPullRequest ? (
            <PageStatus tone="info">Draft prepared</PageStatus>
          ) : (
            <Button size="sm" variant="secondary" onPress={() => setDraftPullRequest(true)}>
              <GitPullRequest className="size-3.5" /> Create pull request
            </Button>
          )}
        </WorkflowSection>

        <WorkflowSection complete={previewRunning} number={3} title="Preview deployment">
          <div className="flex flex-wrap items-center gap-2">
            <PageStatus tone={previewRunning ? "success" : "muted"}>{previewRunning ? "Preview ready" : "Not started"}</PageStatus>
            <Button size="sm" variant="ghost" onPress={() => setPreviewRunning((value) => !value)}>
              <Rocket className="size-3.5" /> {previewRunning ? "Stop" : "Start Preview"}
            </Button>
          </div>
        </WorkflowSection>

        <WorkflowSection complete={prototypeRunning} number={4} title="Prototype">
          <div className="flex flex-wrap items-center gap-2">
            <PageStatus tone={prototypeRunning ? "success" : "muted"}>{prototypeRunning ? "Running locally" : "Not running"}</PageStatus>
            <Button size="sm" variant="ghost" onPress={() => setPrototypeRunning((value) => !value)}>
              <MonitorPlay className="size-3.5" /> {prototypeRunning ? "Stop" : "Start prototype"}
            </Button>
          </div>
        </WorkflowSection>

        <WorkflowSection complete={Boolean(destination)} number={5} title="Start development">
          <div className="space-y-1">
            {[
              { action: "open", icon: Monitor, name: "Local workspace", note: "macOS · Ready" },
              { action: "open", icon: Monitor, name: "os-pc", note: "Windows · Stable" },
              { action: "clone", icon: Download, name: "os-yoga-unix", note: "Linux · Stable" },
            ].map(({ action, icon: Icon, name, note }) => (
              <button
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition ${
                  destination === name ? "bg-current/[.07]" : "hover:bg-current/[.04]"
                }`}
                key={name}
                onClick={() => setDestination(name)}
                type="button"
              >
                <Icon className="size-3.5 shrink-0 text-current/35" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-current/65">{name}</span>
                  <span className="block truncate text-[10px] text-current/30">{note}</span>
                </span>
                <span className="text-[10px] text-current/40">{destination === name ? "selected" : action}</span>
              </button>
            ))}
          </div>
        </WorkflowSection>

        <WorkflowSection complete={testsPassed} number={6} title="Run tests">
          <Button size="sm" variant={testsPassed ? "secondary" : "ghost"} onPress={() => setTestsPassed(true)}>
            {testsPassed ? <Check className="size-3.5 text-emerald-400" /> : <Play className="size-3.5" />}
            {testsPassed ? "Checks passed" : "Run tests"}
          </Button>
        </WorkflowSection>
      </div>

      <div className="mt-8">
        <SectionHeading>Details</SectionHeading>
        <div className="border-y border-current/[.08] py-3">
          <div className="flex items-center justify-between gap-4 py-1.5">
            <span className="text-xs text-current/40">State</span>
            <div className="flex rounded-lg bg-current/[.04] p-0.5">
              {(["Open", "Closed"] as const).map((state) => (
                <button
                  className={`h-7 rounded-md px-3 text-[11px] transition ${issueState === state ? "bg-current/[.09] text-current/80" : "text-current/35"}`}
                  key={state}
                  onClick={() => setIssueState(state)}
                  type="button"
                >
                  {state}
                </button>
              ))}
            </div>
          </div>
          {[
            ["Author", issue.author],
            ["Updated", issue.updated],
            ["Labels", issue.labels.length.toString()],
          ].map(([label, value]) => (
            <div className="flex items-center justify-between gap-4 py-2" key={label}>
              <span className="text-xs text-current/40">{label}</span>
              <span className="truncate text-xs font-medium text-current/65">{value}</span>
            </div>
          ))}
          <a className="mt-2 flex items-center justify-between rounded-lg px-2 py-2 text-xs text-current/55 transition hover:bg-current/[.04] hover:text-current" href={issueUrl} rel="noreferrer" target="_blank">
            View source issue
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      </div>

      <div className="mt-8">
        <SectionHeading>Delivery state</SectionHeading>
        <div className="border-y border-current/[.08] py-2">
          {[
            ["Local checks", testsPassed ? "Passed" : "Not run"],
            ["Review", issue.pullRequest ? "Available" : "Not requested"],
            ["Production", issue.state === "Done" ? "Delivered" : "Not deployed"],
          ].map(([label, value]) => (
            <div className="flex items-center justify-between gap-3 py-2" key={label}>
              <span className="text-xs text-current/40">{label}</span>
              <span className="flex items-center gap-1.5 text-xs font-medium text-current/65">
                <CircleDot className="size-3 text-current/30" /> {value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
