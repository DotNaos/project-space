import { useState } from "react";
import { Button, TextArea } from "@heroui/react";
import { MessageCircle, Send } from "lucide-react";

import { SectionHeading } from "./page-foundation";

interface PrototypeComment {
  author: string;
  body: string;
  id: number;
  time: string;
}

const initialComments: PrototypeComment[] = [
  {
    author: "Oli",
    body: "Keep the project context visible and guide people from the issue into development.",
    id: 1,
    time: "yesterday",
  },
  {
    author: "Codex",
    body: "The board, issue detail, development links, and local review surface are now being designed as one workflow.",
    id: 2,
    time: "18 min",
  },
];

export function IssueComments() {
  const [comments, setComments] = useState(initialComments);
  const [draft, setDraft] = useState("");

  function submitComment() {
    const body = draft.trim();
    if (!body) return;
    setComments((current) => [
      ...current,
      { author: "Oli", body, id: Date.now(), time: "now" },
    ]);
    setDraft("");
  }

  return (
    <section className="mt-9" id="issue-comments">
      <SectionHeading meta={`${comments.length} comments`}>Comments</SectionHeading>
      <div className="border-y border-current/[.08]">
        {comments.map((comment) => (
          <article className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 border-b border-current/[.06] py-4 last:border-0" key={comment.id}>
            <span className="grid size-8 place-items-center rounded-full bg-current/[.06] text-[10px] font-semibold text-current/55">
              {comment.author.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-current/75">{comment.author}</span>
                <span className="text-[11px] text-current/30">{comment.time}</span>
              </div>
              <p className="mt-1.5 text-sm leading-6 text-current/60">{comment.body}</p>
            </div>
          </article>
        ))}
      </div>

      <form
        className="mt-4"
        onSubmit={(event) => {
          event.preventDefault();
          submitComment();
        }}
      >
        <div className="rounded-2xl bg-current/[.04] p-2 ring-1 ring-inset ring-current/[.07] focus-within:ring-current/[.16]">
          <TextArea
            aria-label="Add a comment"
            className="min-h-24 w-full resize-none border-0 bg-transparent px-2 py-1 text-sm leading-6 shadow-none outline-none placeholder:text-current/30"
            placeholder="Add a comment"
            rows={3}
            value={draft}
            variant="secondary"
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex items-center justify-between gap-3 px-1 pb-1">
            <span className="flex items-center gap-1.5 text-[11px] text-current/30">
              <MessageCircle className="size-3.5" /> Markdown supported
            </span>
            <Button isDisabled={!draft.trim()} size="sm" type="submit" variant="primary">
              <Send className="size-3.5" />
              Post comment
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}
