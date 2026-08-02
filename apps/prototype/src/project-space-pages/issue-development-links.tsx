import { Chip, Link } from "@heroui/react";
import { GitBranch, Github, GitMerge, GitPullRequest } from "lucide-react";

import {
  prototypePullRequestLabel,
  type PrototypeIssue,
} from "./issue-fixtures";

export function IssueDevelopmentChips({
  className = "",
  issue,
}: {
  className?: string;
  issue: PrototypeIssue;
}) {
  if (!issue.branch && !issue.pullRequest) return null;

  return (
    <span className={`flex min-w-0 flex-wrap items-center gap-1.5 ${className}`}>
      {issue.branch ? (
        <Link
          aria-label={`Open branch ${issue.branch} on GitHub`}
          className="min-w-0 max-w-full no-underline"
          href={`https://github.com/DotNaos/project-space/tree/${encodeURIComponent(issue.branch)}`}
          rel="noreferrer"
          target="_blank"
        >
          <Chip className="h-6 min-w-0 max-w-full px-2" size="sm" variant="soft">
            <GitBranch className="size-3 shrink-0" />
            <Chip.Label className="truncate text-[10px]">{issue.branch}</Chip.Label>
          </Chip>
        </Link>
      ) : null}
      {issue.pullRequest ? (
        <Link
          aria-label={`Open pull request #${issue.pullRequest.number} on GitHub`}
          className="no-underline"
          href={issue.pullRequest.url}
          rel="noreferrer"
          target="_blank"
        >
          <Chip className={`h-6 px-2 ${issue.pullRequest.state === "Merged" ? "bg-violet-500/10 text-violet-300" : "bg-emerald-500/10 text-emerald-300"}`} size="sm" variant="soft">
            {issue.pullRequest.state === "Merged"
              ? <GitMerge className="size-3 shrink-0" />
              : <GitPullRequest className="size-3 shrink-0" />}
            <Chip.Label className="text-[10px]">{prototypePullRequestLabel(issue.pullRequest)}</Chip.Label>
          </Chip>
        </Link>
      ) : null}
    </span>
  );
}

export function IssueGithubLink({ issue }: { issue: PrototypeIssue }) {
  return (
    <Link
      aria-label={`Open issue #${issue.number} on GitHub`}
      className="gap-1 text-[10px] text-current/35 no-underline hover:text-current/65"
      href={`https://github.com/DotNaos/project-space/issues/${issue.number}`}
      rel="noreferrer"
      target="_blank"
    >
      <Github className="size-3" />
      <span>#{issue.number} · GitHub</span>
      <Link.Icon className="size-2.5" />
    </Link>
  );
}
