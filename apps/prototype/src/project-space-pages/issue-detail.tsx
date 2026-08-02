import { useState } from "react";
import { Button, TextArea } from "@heroui/react";
import {
  ArrowLeft,
  Bot,
  CircleDot,
  ExternalLink,
  GitBranch,
  MessageCircle,
  Pencil,
  Save,
  X,
} from "lucide-react";

import { IssueComments } from "./issue-comments";
import type { PrototypeIssue, PrototypeIssueState } from "./issue-fixtures";
import { IssueWorkflow } from "./issue-workflow";
import { PageStatus, SectionHeading } from "./page-foundation";

const detailTone: Record<PrototypeIssueState, "info" | "muted" | "success"> = {
  Done: "success",
  "In progress": "info",
  Open: "muted",
};

const acceptanceCriteria = [
  "Project context remains visible throughout the work.",
  "Issues support both board and sortable list workflows.",
  "Issue details keep branches, pull requests, tasks, Previews, and delivery evidence together.",
  "The same workflow remains usable at desktop and mobile widths.",
];

function IssueDescription({
  body,
  draft,
  editing,
  onDraftChange,
}: {
  body: string;
  draft: string;
  editing: boolean;
  onDraftChange(value: string): void;
}) {
  return (
    <section>
      <SectionHeading>Issue</SectionHeading>
      <div className="border-y border-current/[.08] py-5">
        {editing ? (
          <TextArea
            aria-label="Issue description"
            className="min-h-32 w-full resize-y rounded-xl bg-current/[.04] px-3 py-2 text-sm leading-6 shadow-none ring-1 ring-inset ring-current/[.08]"
            rows={5}
            value={draft}
            variant="secondary"
            onChange={(event) => onDraftChange(event.target.value)}
          />
        ) : (
          <>
            <p className="max-w-3xl text-sm leading-6 text-current/65">{body}</p>
            <h3 className="mt-7 text-sm font-semibold text-current/80">Direction</h3>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-current/55">
              Replace the page-first product with one guided path: begin with an issue, move into development, review the result, and keep the evidence attached to the work.
            </p>
            <h3 className="mt-7 text-sm font-semibold text-current/80">Acceptance criteria</h3>
            <div className="mt-3 space-y-2.5">
              {acceptanceCriteria.map((criterion, index) => (
                <label className="flex cursor-pointer items-start gap-2.5 text-sm leading-5 text-current/55" key={criterion}>
                  <input className="mt-0.5 size-4 accent-emerald-500" defaultChecked={index < 2} type="checkbox" />
                  <span>{criterion}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function IssueActivity({ issue }: { issue: PrototypeIssue }) {
  const events = [
    { icon: MessageCircle, meta: "now", text: "Requested the complete issue workflow and comments in the new UI." },
    { icon: GitBranch, meta: "12 min", text: issue.branch ? `Connected branch ${issue.branch}.` : "Issue added to the project workflow." },
    { icon: Bot, meta: "today", text: issue.codexTask ? `Codex task ${issue.codexTask} is attached.` : "Ready for the next project task." },
  ];

  return (
    <section className="mt-9">
      <SectionHeading meta={`${events.length} events`}>Activity</SectionHeading>
      <div className="border-y border-current/[.08]">
        {events.map(({ icon: Icon, meta, text }) => (
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-b border-current/[.06] py-3.5 last:border-0" key={text}>
            <span className="grid size-7 place-items-center rounded-full bg-current/[.05] text-current/40"><Icon className="size-3.5" /></span>
            <span className="text-sm leading-5 text-current/55">{text}</span>
            <span className="text-[11px] text-current/25">{meta}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ProjectIssueDetailPage({
  issue,
  onBack,
  projectName,
}: {
  issue: PrototypeIssue;
  onBack(): void;
  projectName: string;
}) {
  const issueUrl = `https://github.com/DotNaos/project-space/issues/${issue.number}`;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(issue.title);
  const [body, setBody] = useState(issue.body);
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftBody, setDraftBody] = useState(body);

  function cancelEditing() {
    setDraftTitle(title);
    setDraftBody(body);
    setEditing(false);
  }

  function saveEditing() {
    setTitle(draftTitle.trim() || title);
    setBody(draftBody.trim() || body);
    setEditing(false);
  }

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col px-5 pb-6 pt-3 @md:px-8 @md:pb-8 @3xl:px-10 @5xl:px-12 @5xl:pt-7">
      <header className="shrink-0 border-b border-current/[.08] pb-5">
        <div className="flex items-center justify-between gap-4">
          <Button size="sm" style={{ color: "inherit" }} variant="ghost" onPress={onBack}>
            <ArrowLeft className="size-4" />
            Issues
          </Button>
          <div className="flex items-center gap-1">
            {editing ? (
              <>
                <Button isIconOnly aria-label="Cancel editing" size="sm" style={{ color: "inherit" }} variant="ghost" onPress={cancelEditing}><X className="size-3.5" /></Button>
                <Button size="sm" variant="secondary" onPress={saveEditing}><Save className="size-3.5" /> Save issue</Button>
              </>
            ) : (
              <Button size="sm" style={{ color: "inherit" }} variant="ghost" onPress={() => setEditing(true)}><Pencil className="size-3.5" /> Edit issue</Button>
            )}
            <a className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-current/55 transition hover:bg-current/[.05] hover:text-current" href={issueUrl} rel="noreferrer" target="_blank">
              <span className="hidden @md:inline">Open on GitHub</span>
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <PageStatus tone={detailTone[issue.state]}>{issue.state}</PageStatus>
          {issue.labels.map((label) => (
            <span className="rounded-full bg-current/[.05] px-2.5 py-1 text-[10px] text-current/45" key={label}>{label}</span>
          ))}
        </div>
        {editing ? (
          <label className="mt-3 flex max-w-4xl items-baseline gap-2">
            <span className="text-2xl font-medium text-current/30 @md:text-[30px]">#{issue.number}</span>
            <input
              aria-label="Issue title"
              className="min-w-0 flex-1 border-b border-current/15 bg-transparent pb-1 text-2xl font-semibold leading-tight tracking-[-.03em] outline-none focus:border-current/40 @md:text-[30px]"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
            />
          </label>
        ) : (
          <h1 className="mt-3 max-w-4xl text-2xl font-semibold leading-tight tracking-[-.03em] @md:text-[30px]">
            <span className="mr-2 font-medium text-current/30">#{issue.number}</span>
            {title}
          </h1>
        )}
        <p className="mt-2 text-xs text-current/35">{projectName} · opened by {issue.author} · updated {issue.updated}</p>
      </header>

      <div className="grid min-h-0 flex-1 gap-9 overflow-y-auto py-6 [scrollbar-width:none] @3xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,.6fr)] @5xl:gap-14 @5xl:py-8">
        <main className="min-w-0">
          <IssueDescription body={body} draft={draftBody} editing={editing} onDraftChange={setDraftBody} />
          <IssueActivity issue={issue} />
          <IssueComments />
        </main>
        <IssueWorkflow issue={issue} />
      </div>
    </section>
  );
}
