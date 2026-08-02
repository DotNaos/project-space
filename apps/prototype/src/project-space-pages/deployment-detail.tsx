import { Accordion, Button } from "@heroui/react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleDot,
  ExternalLink,
  GitCommitHorizontal,
  RefreshCw,
  RotateCcw,
  Workflow,
} from "lucide-react";

import { PageStatus, SectionHeading } from "./page-foundation";

export interface PrototypeDeployment {
  commit: string;
  detail: string;
  name: string;
  status: string;
  time: string;
  tone: "info" | "muted" | "success";
  version: string;
}

const jobs = [
  { duration: "1m 12s", name: "Build and verify", steps: ["Resolve release identity", "TypeScript and tests", "Build web application"], status: "Passed" },
  { duration: "48s", name: "Publish release", steps: ["Verify signature", "Publish artifacts", "Attach release notes"], status: "Passed" },
  { duration: "2m 04s", name: "Deploy production", steps: ["Update VPS checkout", "Restart application", "Verify health and identity"], status: "Passed" },
];

export function DeploymentDetailView({ deployment, onBack }: { deployment: PrototypeDeployment; onBack(): void }) {
  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col px-5 pb-6 pt-3 @md:px-8 @3xl:px-10 @5xl:px-12 @5xl:pt-7">
      <header className="shrink-0 border-b border-current/[.08] pb-5">
        <div className="flex items-center justify-between gap-3">
          <Button size="sm" style={{ color: "inherit" }} variant="ghost" onPress={onBack}><ArrowLeft className="size-4" /> Deployments</Button>
          <div className="flex items-center gap-1"><Button size="sm" style={{ color: "inherit" }} variant="ghost"><RefreshCw className="size-3.5" /> Refresh</Button><Button size="sm" variant="secondary"><ExternalLink className="size-3.5" /> GitHub</Button></div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2"><PageStatus tone={deployment.tone}>{deployment.status}</PageStatus><span className="text-xs text-current/35">{deployment.version}</span></div>
        <h1 className="mt-3 text-2xl font-semibold tracking-[-.03em]">{deployment.name}</h1>
        <p className="mt-2 text-xs text-current/35">{deployment.detail} · {deployment.time}</p>
      </header>

      <div className="grid min-h-0 flex-1 gap-10 overflow-y-auto py-7 [scrollbar-width:none] @3xl:grid-cols-[minmax(0,1.35fr)_minmax(17rem,.65fr)]">
        <main className="min-w-0">
          <SectionHeading meta={`${jobs.length} jobs`}>Workflow run</SectionHeading>
          <Accordion className="border-y border-current/[.08]">
            {jobs.map((job, index) => (
              <Accordion.Item key={job.name}>
                <Accordion.Heading>
                  <Accordion.Trigger className="w-full py-3.5 text-left">
                    <span className="grid size-6 place-items-center rounded-full bg-emerald-500/10 text-emerald-400"><Check className="size-3.5" /></span>
                    <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{job.name}</span><span className="mt-0.5 block text-[11px] text-current/35">Job {index + 1} · {job.duration}</span></span>
                    <PageStatus tone="success">{job.status}</PageStatus>
                    <Accordion.Indicator><ChevronDown className="size-3.5 text-current/35" /></Accordion.Indicator>
                  </Accordion.Trigger>
                </Accordion.Heading>
                <Accordion.Panel>
                  <Accordion.Body className="pb-4 pl-8">
                    {job.steps.map((step) => <div className="flex items-center gap-2 border-t border-current/[.05] py-2 text-xs text-current/50" key={step}><Check className="size-3.5 text-emerald-400" /> {step}</div>)}
                  </Accordion.Body>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
          <section className="mt-9">
            <SectionHeading>Verification</SectionHeading>
            <div className="border-y border-current/[.08]">
              {[
                ["Exact deployed commit", deployment.commit, true],
                ["Application identity", deployment.version, true],
                ["Health endpoint", "Healthy", true],
                ["Rollback target", "v0.4.55", true],
              ].map(([label, value, complete]) => <div className="flex items-center gap-3 border-b border-current/[.06] py-3 last:border-0" key={String(label)}><span className={`grid size-6 place-items-center rounded-full ${complete ? "bg-emerald-500/10 text-emerald-400" : "bg-current/[.05] text-current/35"}`}><Check className="size-3.5" /></span><span className="min-w-0 flex-1 text-xs text-current/45">{label}</span><span className="max-w-48 truncate font-mono text-xs text-current/65">{value}</span></div>)}
            </div>
          </section>
        </main>
        <aside>
          <SectionHeading>Run details</SectionHeading>
          <div className="border-y border-current/[.08] py-2">
            {[["Status", deployment.status], ["Commit", deployment.commit], ["Trigger", "push to main"], ["Actor", "github-actions"], ["Attempt", "1"]].map(([label, value]) => <div className="flex items-center justify-between gap-3 py-2.5" key={label}><span className="text-xs text-current/35">{label}</span><span className="max-w-36 truncate text-xs font-medium text-current/65">{value}</span></div>)}
          </div>
          <div className="mt-7">
            <SectionHeading>Evidence</SectionHeading>
            <div className="space-y-1 border-y border-current/[.08] py-3">
              <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-current/55 hover:bg-current/[.04]" type="button"><GitCommitHorizontal className="size-3.5" /> Exact commit</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-current/55 hover:bg-current/[.04]" type="button"><Workflow className="size-3.5" /> Workflow logs</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-current/55 hover:bg-current/[.04]" type="button"><CircleDot className="size-3.5" /> Health response</button>
            </div>
          </div>
          <Button className="mt-5 w-full" variant="outline"><RotateCcw className="size-4" /> Re-run failed jobs</Button>
        </aside>
      </div>
    </section>
  );
}
