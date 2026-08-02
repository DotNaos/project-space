import { useState, type ReactNode } from "react";
import { Button } from "@heroui/react";
import {
  Check,
  CircleDot,
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
    <section className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] items-center gap-3 border-b border-current/[.06] py-3 last:border-0">
      <StepTitle complete={complete} number={number} title={title} />
      <div className="min-w-0 justify-self-end">{children}</div>
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
      className={`inline-flex h-7 max-w-full items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-[filter,scale] hover:brightness-125 active:scale-[.96] ${
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
            <Button className="h-7 px-2.5 text-xs" size="sm" variant="secondary"><GitBranch className="size-3.5" /> Create branch</Button>
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
            <Button className="h-7 px-2.5 text-xs" size="sm" variant="secondary" onPress={() => setDraftPullRequest(true)}>
              <GitPullRequest className="size-3.5" /> Create PR
            </Button>
          )}
        </WorkflowSection>

        <WorkflowSection complete={previewRunning} number={3} title="Preview deployment">
          <div className="flex items-center justify-end gap-1.5">
            <PageStatus tone={previewRunning ? "success" : "muted"}>{previewRunning ? "Preview ready" : "Not started"}</PageStatus>
            <Button isIconOnly aria-label={previewRunning ? "Stop Preview" : "Start Preview"} className="size-7 min-w-7" size="sm" style={{ color: "inherit" }} variant="ghost" onPress={() => setPreviewRunning((value) => !value)}>
              <Rocket className="size-3.5" />
            </Button>
          </div>
        </WorkflowSection>

        <WorkflowSection complete={prototypeRunning} number={4} title="Prototype">
          <div className="flex items-center justify-end gap-1.5">
            <PageStatus tone={prototypeRunning ? "success" : "muted"}>{prototypeRunning ? "Running" : "Stopped"}</PageStatus>
            <Button isIconOnly aria-label={prototypeRunning ? "Stop prototype" : "Start prototype"} className="size-7 min-w-7" size="sm" style={{ color: "inherit" }} variant="ghost" onPress={() => setPrototypeRunning((value) => !value)}>
              <MonitorPlay className="size-3.5" />
            </Button>
          </div>
        </WorkflowSection>

        <WorkflowSection complete={Boolean(destination)} number={5} title="Start development">
          <div className="flex h-8 max-w-40 items-center rounded-lg bg-current/[.05] px-2 ring-1 ring-inset ring-current/[.06]">
            <Monitor className="size-3.5 shrink-0 text-current/35" />
            <select
              aria-label="Development destination"
              className="min-w-0 flex-1 appearance-none bg-transparent px-2 text-xs text-current/65 outline-none"
              value={destination ?? ""}
              onChange={(event) => setDestination(event.target.value || null)}
            >
              <option value="">Choose</option>
              <option value="Local workspace">Local workspace</option>
              <option value="os-pc">os-pc</option>
              <option value="os-yoga-unix">os-yoga-unix</option>
            </select>
          </div>
        </WorkflowSection>

        <WorkflowSection complete={testsPassed} number={6} title="Run tests">
          <Button className="h-7 px-2.5 text-xs" size="sm" variant={testsPassed ? "secondary" : "ghost"} onPress={() => setTestsPassed(true)}>
            {testsPassed ? <Check className="size-3.5 text-emerald-400" /> : <Play className="size-3.5" />}
            {testsPassed ? "Checks passed" : "Run tests"}
          </Button>
        </WorkflowSection>
      </div>

      <div className="mt-6">
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

      <div className="mt-6">
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
