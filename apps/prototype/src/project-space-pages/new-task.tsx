import { useState } from "react";
import { Button, TextArea } from "@heroui/react";
import {
  ArrowLeft,
  ArrowUp,
  Bug,
  Lightbulb,
  Paperclip,
  Sparkles,
} from "lucide-react";

import type { MockTaskType } from "./task-model";

const taskTypes: Array<{ icon: typeof Sparkles; label: MockTaskType }> = [
  { icon: Sparkles, label: "Feature" },
  { icon: Bug, label: "Bug" },
  { icon: Lightbulb, label: "Idea" },
];

export function suggestTaskTitle(idea: string) {
  const sentence = idea.trim().split(/\n|(?<=[.!?])\s/)[0]
    ?.replace(/^[-*]\s+/, "")
    .replace(/[.!?]+$/, "")
    .trim() ?? "";
  if (sentence.length <= 72) return sentence;
  const shortened = sentence.slice(0, 72);
  return shortened.slice(0, shortened.lastIndexOf(" ")).trim() || shortened.trim();
}

export function NewTaskPage({
  onCreate,
  projectName,
}: {
  onCreate(input: { body: string; labels: string[]; title: string; type: MockTaskType }): void;
  projectName: string;
}) {
  const [idea, setIdea] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
  const [type, setType] = useState<MockTaskType>("Feature");

  function reviewIdea() {
    const value = idea.trim();
    if (!value) return;
    setTitle(suggestTaskTitle(value));
    setBody(value);
    setReviewing(true);
  }

  function createTask() {
    const cleanTitle = title.trim();
    const cleanBody = body.trim();
    if (!cleanTitle || !cleanBody) return;
    onCreate({
      body: cleanBody,
      labels: labels.split(",").map((label) => label.trim()).filter(Boolean),
      title: cleanTitle,
      type,
    });
    setIdea("");
    setReviewing(false);
  }

  if (!reviewing) {
    return (
      <section className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5">
          <div className="mb-10 grid size-11 place-items-center rounded-full border border-current/10 text-current/45">
            <span className="text-sm font-semibold">PS</span>
          </div>
        </div>
        <div className="shrink-0 px-4 pb-5 @md:px-6 @md:pb-7 @3xl:px-10 @3xl:pb-9">
          <form
            className="mx-auto w-full max-w-3xl rounded-3xl bg-current/[.055] p-2 ring-1 ring-inset ring-current/[.08]"
            onSubmit={(event) => {
              event.preventDefault();
              reviewIdea();
            }}
          >
            <textarea
              aria-label="Describe a task"
              autoFocus
              className="block max-h-36 min-h-16 w-full resize-none bg-transparent px-3 py-2 text-[15px] leading-6 outline-none placeholder:text-current/35"
              placeholder="Describe a feature, bug, or idea"
              rows={2}
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                reviewIdea();
              }}
            />
            <div className="flex items-center justify-between gap-2 px-1 pb-1">
              <Button isIconOnly aria-label="Attach context" size="sm" style={{ color: "inherit" }} variant="ghost">
                <Paperclip className="size-4" />
              </Button>
              <Button
                isIconOnly
                aria-label="Review task"
                className={idea.trim() ? "" : "opacity-45"}
                isDisabled={!idea.trim()}
                size="sm"
                type="submit"
                variant="primary"
              >
                <ArrowUp className="size-4" />
              </Button>
            </div>
          </form>
          <p className="mx-auto mt-2 max-w-3xl px-3 text-center text-[10px] leading-4 text-current/30">
            This creates a mocked Task in {projectName}. Nothing external will change.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col px-5 pb-5 pt-2 @md:px-8 @3xl:px-10 @5xl:pt-7">
      <header className="flex shrink-0 items-center justify-between border-b border-current/[.08] pb-4">
        <Button size="sm" style={{ color: "inherit" }} variant="ghost" onPress={() => setReviewing(false)}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <span className="text-xs text-current/35">Review before creating</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-6 [scrollbar-width:none]">
        <h1 className="text-2xl font-semibold tracking-[-.03em] @md:text-3xl">New task</h1>
        <p className="mt-2 text-sm text-current/40">Shape the intent now. Development details come later.</p>

        <div className="mt-8 space-y-7">
          <label className="block">
            <span className="text-xs font-medium text-current/50">Title</span>
            <input
              aria-label="Task title"
              className="mt-2 h-11 w-full border-b border-current/15 bg-transparent px-0 text-lg font-medium outline-none transition-colors focus:border-current/45"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-current/50">Description</span>
            <TextArea
              aria-label="Task description"
              className="mt-2 min-h-36 w-full resize-y rounded-2xl bg-current/[.04] px-4 py-3 text-sm leading-6 shadow-none ring-1 ring-inset ring-current/[.08]"
              rows={6}
              value={body}
              variant="secondary"
              onChange={(event) => setBody(event.target.value)}
            />
          </label>

          <fieldset>
            <legend className="text-xs font-medium text-current/50">Type</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {taskTypes.map(({ icon: Icon, label }) => (
                <button
                  aria-pressed={type === label}
                  className={`flex h-10 items-center gap-2 rounded-xl px-3 text-sm transition-[background-color,color,scale] active:scale-[.96] ${
                    type === label ? "bg-current/[.1] text-current" : "bg-current/[.035] text-current/45 hover:text-current/70"
                  }`}
                  key={label}
                  onClick={() => setType(label)}
                  type="button"
                >
                  <Icon className="size-4" strokeWidth={type === label ? 2 : 1.6} />
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="block">
            <span className="text-xs font-medium text-current/50">Labels</span>
            <input
              aria-label="Task labels"
              className="mt-2 h-10 w-full rounded-xl bg-current/[.04] px-3 text-sm outline-none ring-1 ring-inset ring-current/[.08] placeholder:text-current/25 focus:ring-current/[.2]"
              placeholder="frontend, design"
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
            />
          </label>
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-current/[.08] pt-4">
        <span className="hidden text-xs text-current/30 @md:block">Mock data · browser session only</span>
        <Button
          className="w-full @md:ml-auto @md:w-auto"
          isDisabled={!title.trim() || !body.trim()}
          variant="primary"
          onPress={createTask}
        >
          Create task
        </Button>
      </footer>
    </section>
  );
}
