import { useRef, useState, type ReactNode } from "react";
import { Button, TextArea } from "@heroui/react";
import ReactMarkdown from "react-markdown";
import {
  AtSign,
  Bold,
  ChevronDown,
  CircleCheck,
  Code2,
  Heading,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Paperclip,
  Quote,
  Send,
} from "lucide-react";

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

function ToolbarButton({ children, label, onPress }: { children: ReactNode; label: string; onPress(): void }) {
  return (
    <button
      aria-label={label}
      className="grid size-8 shrink-0 place-items-center rounded-md text-current/40 transition-[background-color,color,scale] duration-150 hover:bg-current/[.06] hover:text-current/70 active:scale-[.96]"
      onClick={onPress}
      type="button"
    >
      {children}
    </button>
  );
}

export function IssueComments() {
  const [comments, setComments] = useState(initialComments);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"Preview" | "Write">("Write");
  const [closeOnComment, setCloseOnComment] = useState(false);
  const [issueClosed, setIssueClosed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function insertMarkdown(before: string, after = "") {
    setDraft((current) => `${current}${current && !current.endsWith("\n") ? " " : ""}${before}${after}`);
  }

  function submitComment() {
    const body = draft.trim();
    if (!body) return;
    setComments((current) => [
      ...current,
      { author: "Oli", body, id: Date.now(), time: "now" },
    ]);
    if (closeOnComment) setIssueClosed(true);
    setDraft("");
    setMode("Write");
  }

  return (
    <section className="mt-10" id="issue-comments">
      <div className="relative ml-4 border-l border-current/[.08] pl-7">
        {comments.map((comment) => (
          <article className="relative pb-5 last:pb-0" key={comment.id}>
            <span className="absolute -left-[2.75rem] top-0 grid size-8 place-items-center rounded-full bg-[var(--prototype-screen-background)] text-[10px] font-semibold text-current/60 ring-4 ring-[var(--prototype-screen-background)]">
              {comment.author.slice(0, 2).toUpperCase()}
            </span>
            <div className="overflow-hidden rounded-xl ring-1 ring-inset ring-current/[.09]">
              <header className="flex items-center gap-2 border-b border-current/[.07] bg-current/[.025] px-3.5 py-2.5">
                <span className="text-xs font-medium text-current/75">{comment.author}</span>
                <span className="text-[11px] text-current/30">commented {comment.time}</span>
              </header>
              <p className="px-3.5 py-4 text-sm leading-6 text-current/60">{comment.body}</p>
            </div>
          </article>
        ))}
      </div>

      <form
        className="mt-9"
        onSubmit={(event) => {
          event.preventDefault();
          submitComment();
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-[-.02em]">Add a comment</h2>
          {issueClosed ? <span className="flex items-center gap-1.5 text-xs text-violet-300"><CircleCheck className="size-3.5" /> Issue closed</span> : null}
        </div>

        <div className="overflow-hidden rounded-xl ring-1 ring-inset ring-current/[.12] focus-within:ring-current/[.24]">
          <div className="flex min-w-0 items-center border-b border-current/[.08] bg-current/[.025]">
            {(["Write", "Preview"] as const).map((tab) => (
              <button
                className={`h-10 border-r border-current/[.08] px-4 text-xs font-medium transition-colors ${mode === tab ? "bg-[var(--prototype-screen-background)] text-current/80" : "text-current/40 hover:text-current/65"}`}
                key={tab}
                onClick={() => setMode(tab)}
                type="button"
              >
                {tab}
              </button>
            ))}
            <div className="ml-auto flex min-w-0 items-center gap-0.5 overflow-x-auto px-2 [scrollbar-width:none]">
              <ToolbarButton label="Heading" onPress={() => insertMarkdown("## ")}><Heading className="size-4" /></ToolbarButton>
              <ToolbarButton label="Bold" onPress={() => insertMarkdown("**", "**")}><Bold className="size-4" /></ToolbarButton>
              <ToolbarButton label="Italic" onPress={() => insertMarkdown("_", "_")}><Italic className="size-4" /></ToolbarButton>
              <ToolbarButton label="Quote" onPress={() => insertMarkdown("> ")}><Quote className="size-4" /></ToolbarButton>
              <ToolbarButton label="Code" onPress={() => insertMarkdown("`", "`")}><Code2 className="size-4" /></ToolbarButton>
              <ToolbarButton label="Link" onPress={() => insertMarkdown("[", "](url)")}><Link className="size-4" /></ToolbarButton>
              <ToolbarButton label="Bulleted list" onPress={() => insertMarkdown("- ")}><List className="size-4" /></ToolbarButton>
              <ToolbarButton label="Numbered list" onPress={() => insertMarkdown("1. ")}><ListOrdered className="size-4" /></ToolbarButton>
              <ToolbarButton label="Task list" onPress={() => insertMarkdown("- [ ] ")}><ListChecks className="size-4" /></ToolbarButton>
              <ToolbarButton label="Mention" onPress={() => insertMarkdown("@")}><AtSign className="size-4" /></ToolbarButton>
            </div>
          </div>

          {mode === "Write" ? (
            <TextArea
              aria-label="Add a comment"
              className="min-h-40 w-full resize-y border-0 bg-transparent px-4 py-3 font-mono text-sm leading-6 shadow-none outline-none placeholder:text-current/30"
              placeholder="Use Markdown to format your comment"
              rows={6}
              value={draft}
              variant="secondary"
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <div className="min-h-40 px-4 py-4 text-sm leading-6 text-current/65 [&_a]:text-sky-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-current/20 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-current/[.06] [&_code]:px-1 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc">
              {draft.trim() ? <ReactMarkdown>{draft}</ReactMarkdown> : <p className="text-current/30">Nothing to preview yet.</p>}
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-col gap-3 @md:flex-row @md:items-center @md:justify-between">
          <input ref={fileInputRef} className="hidden" multiple type="file" />
          <button className="flex items-center gap-2 text-xs text-current/40 transition-colors hover:text-current/65" onClick={() => fileInputRef.current?.click()} type="button">
            <Paperclip className="size-4" /> Paste, drop, or click to add files
          </button>
          <div className="flex items-center justify-end gap-2">
            <Button className="min-w-32" size="sm" style={{ color: "inherit" }} variant="secondary" onPress={() => setCloseOnComment((value) => !value)}>
              <CircleCheck className={`size-4 ${closeOnComment ? "text-violet-300" : "text-current/40"}`} />
              {closeOnComment ? "Close with comment" : "Keep issue open"}
              <ChevronDown className="size-3.5 text-current/35" />
            </Button>
            <Button isDisabled={!draft.trim()} size="sm" type="submit" variant="primary">
              <Send className="size-3.5" /> Comment
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}
