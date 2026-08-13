import { Modal } from '@heroui/react';
import { Fragment, useEffect, useState } from 'react';
import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  RefreshCw
} from 'lucide-react';

import { Button } from '@/app/dotnaos-ui';
import type { CodexAuthorizationResult } from '@/shared/codex-authorization-api';
import type { GitHubCodespaceRunnerResult } from '@/shared/github-codespace-runner-api';
import type { GitHubOAuthDeviceStartResult } from '@/shared/project-space-api';
import { copyText } from './clipboard';

export { copyText } from './clipboard';

export type GitHubCodespaceConnectionKind =
  | 'codex'
  | 'connection'
  | 'connector'
  | 'github';

export interface GitHubCodespaceFlowFailure {
  message: string;
  retry: 'codex' | 'github' | 'status';
}

interface GitHubCodespaceConnectionPanelProps {
  authorization?: CodexAuthorizationResult;
  busy: boolean;
  embedded: boolean;
  failure?: GitHubCodespaceFlowFailure;
  githubFlow?: GitHubOAuthDeviceStartResult;
  isOpen: boolean;
  kind?: GitHubCodespaceConnectionKind;
  onAuthorizeCodex(action: 'cancel' | 'start'): void;
  onCheckGitHub(): void;
  onOpenChange(isOpen: boolean): void;
  onRetry(): void;
  runner?: GitHubCodespaceRunnerResult;
}

function OneTimeCode({
  code
}: {
  code: string;
}) {
  const compactCode = code.replace(/\s/g, '');
  const separatedGroups = compactCode.split('-').filter(Boolean);
  const groups = separatedGroups.length > 1
    ? separatedGroups
    : compactCode.match(/.{1,4}/g) ?? [];

  return (
    <code
      aria-label={code}
      className="flex min-w-0 items-center justify-center gap-3 py-2"
    >
      {groups.map((group, groupIndex) => (
        <Fragment key={`${group}-${groupIndex}`}>
          {groupIndex > 0 ? (
            <span
              aria-hidden="true"
              className="shrink-0 font-mono text-lg font-semibold text-neutral-500"
              data-code-separator="true"
            >
              -
            </span>
          ) : null}
          <span
            aria-hidden="true"
            className="grid min-w-0 flex-1 grid-cols-4 gap-1.5 md:gap-2"
          >
            {[...group].map((character, characterIndex) => (
              <span
                key={`${character}-${characterIndex}`}
                data-code-character="true"
                className="flex aspect-square min-w-0 w-full items-center justify-center rounded-lg bg-white/[.07] font-mono text-2xl font-semibold text-neutral-50 sm:text-3xl"
              >
                {character}
              </span>
            ))}
          </span>
        </Fragment>
      ))}
    </code>
  );
}

function openExternalUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function ConnectionContent({
  authorization,
  busy,
  failure,
  githubFlow,
  kind,
  onAuthorizeCodex,
  onCheckGitHub,
  onRetry,
  runner
}: Omit<GitHubCodespaceConnectionPanelProps, 'embedded' | 'isOpen' | 'onOpenChange'>) {
  const displayedCode = kind === 'github'
    ? githubFlow?.userCode
    : kind === 'codex'
      ? authorization?.userCode
      : undefined;
  const [automaticCopyFailed, setAutomaticCopyFailed] = useState(false);
  const [manualCopyConfirmed, setManualCopyConfirmed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAutomaticCopyFailed(false);
    setManualCopyConfirmed(false);
    if (!displayedCode) return;
    if (!navigator.clipboard?.writeText) {
      setAutomaticCopyFailed(true);
      return;
    }
    void navigator.clipboard.writeText(displayedCode).catch(() => {
      if (!cancelled) setAutomaticCopyFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [displayedCode]);

  useEffect(() => {
    if (!manualCopyConfirmed) return;
    const timeout = window.setTimeout(() => setManualCopyConfirmed(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [manualCopyConfirmed]);

  const copyDisplayedCode = async (code?: string) => {
    if (code && await copyText(code)) setManualCopyConfirmed(true);
  };

  return (
    <>
      <div className="grid gap-3">
        {kind === 'github' && githubFlow ? (
          <>
            <div className="flex min-h-7 items-center justify-between gap-2">
              <span className="text-xs text-neutral-400">
                Enter this one-time code on GitHub:
              </span>
              {automaticCopyFailed ? (
                <Button
                  aria-label={manualCopyConfirmed ? 'One-time code copied' : 'Copy one-time code'}
                  className="min-h-7 shrink-0 !rounded-full px-2 text-xs"
                  size="sm"
                  variant="ghost"
                  onPress={() => void copyDisplayedCode(githubFlow.userCode)}
                >
                  {manualCopyConfirmed ? (
                    <Check className="size-3" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                  {manualCopyConfirmed ? 'Copied' : 'Copy'}
                </Button>
              ) : null}
            </div>
            <OneTimeCode code={githubFlow.userCode ?? ''} />
          </>
        ) : kind === 'codex' && authorization ? (
          <>
            <div className="flex min-h-7 items-center justify-between gap-2">
              <span className="text-xs text-neutral-400">
                Enter this one-time code on ChatGPT:
              </span>
              {automaticCopyFailed ? (
                <Button
                  aria-label={manualCopyConfirmed ? 'One-time code copied' : 'Copy one-time code'}
                  className="min-h-7 shrink-0 !rounded-full px-2 text-xs"
                  size="sm"
                  variant="ghost"
                  onPress={() => void copyDisplayedCode(authorization.userCode)}
                >
                  {manualCopyConfirmed ? (
                    <Check className="size-3" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                  {manualCopyConfirmed ? 'Copied' : 'Copy'}
                </Button>
              ) : null}
            </div>
            <OneTimeCode code={authorization.userCode ?? ''} />
          </>
        ) : kind === 'connector' ? (
          <p className="text-xs leading-5 text-neutral-300">
            GitHub requires approval before the Project Space connector can run in this Codespace.
          </p>
        ) : (
          <p className={`text-xs leading-5 ${kind === 'connection' ? 'text-amber-300' : 'text-neutral-300'}`}>
            {failure?.message ?? runner?.message ?? 'Retry the connection without changing the existing Codespace.'}
          </p>
        )}
      </div>

      <div className="mt-4 grid gap-2">
        {kind === 'github' && githubFlow ? (
          <>
            <Button
              className="mx-auto !rounded-full !bg-transparent px-3 text-neutral-400 hover:!bg-transparent hover:text-neutral-100 whitespace-nowrap"
              isDisabled={busy}
              size="sm"
              variant="ghost"
              onPress={onCheckGitHub}
            >
              <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} />
              Refresh login status
            </Button>
            {githubFlow.verificationUri ? (
              <Button
                className="!rounded-full whitespace-nowrap"
                fullWidth
                size="md"
                variant="primary"
                onPress={() => openExternalUrl(githubFlow.verificationUri ?? '')}
              >
                Open GitHub <ExternalLink className="size-3.5" />
              </Button>
            ) : null}
          </>
        ) : kind === 'codex' && authorization ? (
          <>
            {authorization.verificationUrl ? (
              <Button
                className="!rounded-full whitespace-nowrap"
                fullWidth
                size="md"
                variant="secondary"
                onPress={() => openExternalUrl(authorization.verificationUrl ?? '')}
              >
                Open ChatGPT <ExternalLink className="size-3.5" />
              </Button>
            ) : null}
            <Button
              className="!rounded-full whitespace-nowrap"
              fullWidth
              size="md"
              variant="ghost"
              onPress={() => onAuthorizeCodex('cancel')}
            >
              Cancel sign in
            </Button>
          </>
        ) : kind === 'connector' && runner?.approvalUrl ? (
          <Button
            className="!rounded-full whitespace-nowrap"
            fullWidth
            size="md"
            variant="primary"
            onPress={() => openExternalUrl(runner.approvalUrl ?? '')}
          >
            Open approval <ExternalLink className="size-3.5" />
          </Button>
        ) : kind === 'connection' ? (
          <Button
            className="!rounded-full whitespace-nowrap"
            fullWidth
            isDisabled={busy}
            size="md"
            variant="primary"
            onPress={onRetry}
          >
            <RefreshCw className="size-3.5" /> Retry connection
          </Button>
        ) : null}
      </div>
    </>
  );
}

export function GitHubCodespaceConnectionPanel({
  authorization,
  busy,
  embedded,
  failure,
  githubFlow,
  isOpen,
  kind,
  onAuthorizeCodex,
  onCheckGitHub,
  onOpenChange,
  onRetry,
  runner
}: GitHubCodespaceConnectionPanelProps) {
  if (!kind) return null;

  const content = (
    <ConnectionContent
      authorization={authorization}
      busy={busy}
      failure={failure}
      githubFlow={githubFlow}
      kind={kind}
      onAuthorizeCodex={onAuthorizeCodex}
      onCheckGitHub={onCheckGitHub}
      onRetry={onRetry}
      runner={runner}
    />
  );

  if (embedded) {
    return (
      <div className={kind === 'connection'
        ? 'mx-3 rounded-xl bg-amber-500/10 px-3 py-3'
        : 'mx-3'}>
        {content}
      </div>
    );
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop className="z-[140] bg-black/75" variant="blur">
        <Modal.Container className="p-3" placement="center" scroll="inside" size="sm">
          <Modal.Dialog className="overflow-hidden border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/70">
            <Modal.CloseTrigger aria-label="Close Codespace connection dialog" />
            <Modal.Header className="block border-b border-neutral-800 px-5 py-4 pr-12">
              <Modal.Heading className="text-base font-semibold">
                {kind === 'github'
                  ? 'Connect GitHub'
                  : kind === 'codex'
                    ? 'Sign in to Codex'
                    : kind === 'connector'
                      ? 'Approve Codespace connector'
                      : 'Restore Codespace connection'}
              </Modal.Heading>
              <p className="mt-1 text-xs leading-5 text-neutral-400">
                {kind === 'github'
                  ? 'Authorize Project Space to inspect and prepare this Codespace.'
                  : kind === 'codex'
                    ? 'Use your ChatGPT subscription. No API key is required.'
                    : failure?.message ?? runner?.message}
              </p>
            </Modal.Header>
            <Modal.Body className="px-5 py-5">{content}</Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
