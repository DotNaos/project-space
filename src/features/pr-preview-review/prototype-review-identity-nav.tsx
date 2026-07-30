import {
  Bot,
  ExternalLink,
  FolderGit2,
  GitPullRequest,
  Monitor,
  OctagonAlert,
  ShieldCheck
} from 'lucide-react';

import type { PullRequestTestSurfacesResult } from '../../shared/pr-preview-test-surfaces-api';
import {
  parsePrototypeLaunchRouteIdentity,
  prototypeIdentityLinks,
  prototypeResultMatchesIdentity
} from '../../shared/prototype-launch';
import type { PrototypeTheme } from '../../shared/prototype-canvas';

interface PrototypeReviewIdentityNavProps {
  result?: PullRequestTestSurfacesResult;
  search: string;
  theme: PrototypeTheme;
}

const actionClass =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400';

export function PrototypeReviewIdentityNav({
  result,
  search,
  theme
}: PrototypeReviewIdentityNavProps) {
  const identity = parsePrototypeLaunchRouteIdentity(search);
  const verifiedLive = result?.liveContext.state === 'available'
    ? result.liveContext
    : undefined;
  const completeIdentity = {
    ...identity,
    branchName: identity.branchName ?? verifiedLive?.branchName,
    headSha: identity.headSha ?? result?.headSha,
    machineId: identity.machineId ?? verifiedLive?.machineId,
    projectId: identity.projectId ?? verifiedLive?.projectId,
    pullRequestNumber: identity.pullRequestNumber ?? result?.pullRequestNumber,
    repositoryFullName: identity.repositoryFullName ?? result?.repositoryFullName,
    threadId: identity.threadId ??
      (result?.feedback.state === 'available' ? result.feedback.threadId : undefined),
    worktreeId: identity.worktreeId ?? verifiedLive?.worktreeId
  };
  if (!completeIdentity.issueNumber && !completeIdentity.pullRequestNumber) return null;
  const links = prototypeIdentityLinks(completeIdentity);
  const exactHead = Boolean(
    result &&
    identity.headSha &&
    identity.pullRequestNumber &&
    identity.repositoryFullName &&
    prototypeResultMatchesIdentity(result, {
      headSha: identity.headSha,
      pullRequestNumber: identity.pullRequestNumber,
      repositoryFullName: identity.repositoryFullName
    })
  );
  const mismatch = Boolean(result && identity.headSha && !exactHead);
  const tone = theme === 'dark'
    ? 'border-neutral-800 bg-neutral-950 text-neutral-300'
    : 'border-neutral-200 bg-white text-neutral-700';
  const actionTone = theme === 'dark'
    ? 'text-neutral-400 hover:bg-neutral-800 hover:text-white'
    : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-950';

  return (
    <nav
      aria-label="Prototype identity navigation"
      className={`z-30 flex min-h-10 min-w-0 shrink-0 items-center gap-2 border-y px-3 py-1.5 max-[640px]:px-2 ${tone}`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
        {mismatch ? (
          <OctagonAlert aria-hidden className="size-3.5 shrink-0 text-amber-400" />
        ) : (
          <ShieldCheck
            aria-hidden
            className={`size-3.5 shrink-0 ${exactHead ? 'text-emerald-400' : 'text-neutral-500'}`}
          />
        )}
        <span className="min-w-0 truncate">
          {completeIdentity.repositoryFullName ?? 'Repository'}
          {completeIdentity.issueNumber ? ` · issue #${completeIdentity.issueNumber}` : ''}
          {completeIdentity.pullRequestNumber ? ` · PR #${completeIdentity.pullRequestNumber}` : ''}
        </span>
        {completeIdentity.headSha ? (
          <code
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
              mismatch
                ? 'bg-amber-500/15 text-amber-300'
                : theme === 'dark'
                  ? 'bg-neutral-900 text-neutral-400'
                  : 'bg-neutral-100 text-neutral-600'
            }`}
          >
            {completeIdentity.headSha.slice(0, 7)}
          </code>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {links.issue ? (
          <IdentityLink href={links.issue} label={`Issue #${completeIdentity.issueNumber}`} tone={actionTone}>
            <span aria-hidden className="text-[11px] font-semibold">#{completeIdentity.issueNumber}</span>
          </IdentityLink>
        ) : null}
        {links.pullRequest ? (
          <IdentityLink external href={links.pullRequest} label={`Pull request #${completeIdentity.pullRequestNumber}`} tone={actionTone}>
            <GitPullRequest aria-hidden className="size-3.5" />
          </IdentityLink>
        ) : null}
        {links.task ? (
          <IdentityLink href={links.task} label="Owning Codex task" tone={actionTone}>
            <Bot aria-hidden className="size-3.5" />
          </IdentityLink>
        ) : null}
        {links.worktree ? (
          <IdentityLink href={links.worktree} label="Project-managed worktree" tone={actionTone}>
            <FolderGit2 aria-hidden className="size-3.5" />
          </IdentityLink>
        ) : null}
        {links.machine ? (
          <IdentityLink href={links.machine} label="Development machine" tone={actionTone}>
            <Monitor aria-hidden className="size-3.5" />
          </IdentityLink>
        ) : null}
      </div>
    </nav>
  );
}

function IdentityLink({
  children,
  external = false,
  href,
  label,
  tone
}: {
  children: React.ReactNode;
  external?: boolean;
  href: string;
  label: string;
  tone: string;
}) {
  return (
    <a
      aria-label={label}
      className={`${actionClass} ${tone}`}
      href={href}
      rel={external ? 'noreferrer' : undefined}
      target={external ? '_blank' : undefined}
      title={label}
    >
      {children}
      {external ? <ExternalLink aria-hidden className="sr-only" /> : null}
    </a>
  );
}
