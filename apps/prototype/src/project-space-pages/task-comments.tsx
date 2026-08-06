import { useState } from "react";
import { Button, TextArea } from "@heroui/react";
import ReactMarkdown from "react-markdown";
import { Eye, MessageCircle, PencilLine, Send } from "lucide-react";

import type { MockTaskComment } from "./task-model";

export function TaskComments({
  comments,
  onSubmit,
}: {
  comments: MockTaskComment[];
  onSubmit(body: string): void;
}) {
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);

  function submit() {
    if (!draft.trim()) return;
    onSubmit(draft);
    setDraft("");
    setPreview(false);
  }

  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-current/75">
        <MessageCircle className="size-4 text-current/40" /> Discussion
        <span className="text-xs font-normal tabular-nums text-current/30">{comments.length}</span>
      </h2>

      {comments.length ? (
        <div className="mt-4 border-l border-current/[.09] pl-5">
          {comments.map((comment) => (
            <article className="relative border-b border-current/[.07] py-4 first:pt-0 last:border-0" key={comment.id}>
              <span className="absolute -left-[1.55rem] top-1.5 size-2 rounded-full bg-current/25 ring-4 ring-[var(--prototype-screen-background)]" />
              <header className="flex items-center gap-2 text-xs">
                <span className="font-medium text-current/70">{comment.author}</span>
                <span className="text-current/25">{comment.time}</span>
              </header>
              <p className="mt-2 text-sm leading-6 text-current/55">{comment.body}</p>
            </article>
          ))}
        </div>
      ) : <p className="mt-4 text-sm text-current/30">No comments yet.</p>}

      <form
        className="mt-6 overflow-hidden rounded-2xl bg-current/[.035] ring-1 ring-inset ring-current/[.09] focus-within:ring-current/[.2]"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex items-center gap-1 border-b border-current/[.07] p-1.5">
          <button
            className={`flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors ${!preview ? "bg-current/[.08] text-current/75" : "text-current/35"}`}
            onClick={() => setPreview(false)}
            type="button"
          ><PencilLine className="size-3.5" /> Write</button>
          <button
            className={`flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors ${preview ? "bg-current/[.08] text-current/75" : "text-current/35"}`}
            onClick={() => setPreview(true)}
            type="button"
          ><Eye className="size-3.5" /> Preview</button>
        </div>
        {preview ? (
          <div className="min-h-28 px-4 py-3 text-sm leading-6 text-current/60 [&_a]:text-blue-300 [&_code]:rounded [&_code]:bg-current/[.07] [&_code]:px-1 [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc">
            {draft.trim() ? <ReactMarkdown>{draft}</ReactMarkdown> : <span className="text-current/25">Nothing to preview.</span>}
          </div>
        ) : (
          <TextArea
            aria-label="Add Task comment"
            className="min-h-28 w-full resize-y border-0 bg-transparent px-4 py-3 text-sm leading-6 shadow-none outline-none placeholder:text-current/25"
            placeholder="Add a comment with Markdown"
            rows={4}
            value={draft}
            variant="secondary"
            onChange={(event) => setDraft(event.target.value)}
          />
        )}
        <div className="flex justify-end px-2 pb-2">
          <Button isDisabled={!draft.trim()} size="sm" type="submit" variant="primary">
            <Send className="size-3.5" /> Comment
          </Button>
        </div>
      </form>
    </section>
  );
}
