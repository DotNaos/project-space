import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { Modal } from '@heroui/react';

import { Button, Text } from '@/app/dotnaos-ui';
import type {
  GitHubCatalogResult,
  GitHubOAuthDeviceStartResult
} from '@/shared/project-space-api';
import { getGitHubConnectPanelPresentation } from './github-connect-panel-model';
import { GitHubMark } from './github-mark';

export function GitHubConnectPanel({
  flow,
  githubCatalog,
  isConnecting,
  onConnect,
  onPoll,
  onRetry
}: {
  flow?: GitHubOAuthDeviceStartResult;
  githubCatalog: GitHubCatalogResult;
  isConnecting: boolean;
  onConnect(): Promise<void>;
  onPoll(): Promise<void>;
  onRetry(): Promise<unknown> | void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState('');
  const [hasCopiedCode, setHasCopiedCode] = useState(false);
  const presentation = getGitHubConnectPanelPresentation({
    flow,
    githubCatalog,
    isConnecting
  });
  const { isLoadError } = presentation;
  const pendingFlow = flow?.status === 'pending' ? flow : undefined;
  const isPending = Boolean(pendingFlow);

  useEffect(() => {
    if (githubCatalog.status === 'connected') {
      setIsOpen(false);
      setError('');
    }
  }, [githubCatalog.status]);

  useEffect(() => {
    if (isPending) {
      setError('');
    }
  }, [isPending]);

  if (githubCatalog.status === 'connected') {
    return null;
  }

  async function startLogin() {
    setIsOpen(true);
    setError('');
    setHasCopiedCode(false);
    if (isPending || isConnecting) return;

    try {
      await onConnect();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'GitHub login could not be started.');
    }
  }

  async function checkLogin() {
    setError('');
    try {
      await onPoll();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'GitHub login could not be checked.');
    }
  }

  async function copyCode() {
    if (!flow?.userCode) return;
    try {
      await navigator.clipboard.writeText(flow.userCode);
      setHasCopiedCode(true);
      window.setTimeout(() => setHasCopiedCode(false), 1_500);
    } catch {
      setError('The GitHub code could not be copied.');
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <Text className="block text-sm font-medium text-neutral-100">
            {presentation.title}
          </Text>
          <Text className="mt-1 block max-w-xl text-sm leading-5 text-neutral-500">
            {presentation.description}
          </Text>
        </div>
        {isLoadError ? (
          <Button
            className="shrink-0 self-start sm:self-auto"
            size="sm"
            variant="outline"
            isDisabled={isConnecting}
            onPress={() => void onRetry()}
          >
            <RefreshCw className={isConnecting ? 'size-4 animate-spin' : 'size-4'} />
            Retry
          </Button>
        ) : (
          <Button
            className="shrink-0 self-start sm:self-auto"
            size="sm"
            isDisabled={presentation.primaryActionDisabled}
            onPress={() => void startLogin()}
          >
            {isConnecting && !isPending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <GitHubMark className="size-4" />
            )}
            {presentation.primaryActionLabel}
          </Button>
        )}
      </div>

      <Modal isOpen={isOpen} onOpenChange={setIsOpen}>
        <Modal.Backdrop variant="blur" className="z-[90] bg-black/75">
          <Modal.Container placement="center" size="md" className="p-3">
            <Modal.Dialog className="overflow-hidden border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/70 sm:max-w-lg">
              <Modal.CloseTrigger aria-label="Close GitHub login" />
              <Modal.Header className="items-center border-b border-neutral-900 px-6 py-5 text-center">
                <Modal.Icon className="bg-neutral-900 text-neutral-100">
                  <GitHubMark className="size-5" />
                </Modal.Icon>
                <Modal.Heading className="text-lg font-semibold">Connect GitHub</Modal.Heading>
                <Text className="max-w-sm text-sm leading-5 text-neutral-500">
                  Authorize Project Space with GitHub's secure device login.
                </Text>
              </Modal.Header>

              <Modal.Body className="space-y-5 px-6 py-6">
                {error ? (
                  <div role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                    {error}
                  </div>
                ) : null}

                {isPending ? (
                  <>
                    <div className="text-center">
                      <Text className="block text-xs font-medium uppercase tracking-[0.18em] text-neutral-500">
                        Your one-time code
                      </Text>
                      <div className="mt-3 flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/70 p-2 pl-4">
                        <code className="min-w-0 flex-1 text-left font-mono text-xl font-semibold tracking-[0.12em] text-neutral-50 sm:text-2xl">
                          {pendingFlow?.userCode}
                        </code>
                        <Button
                          aria-label="Copy GitHub login code"
                          isIconOnly
                          size="sm"
                          variant="ghost"
                          onPress={() => void copyCode()}
                        >
                          {hasCopiedCode ? <Check className="size-4 text-emerald-300" /> : <Copy className="size-4" />}
                        </Button>
                      </div>
                    </div>

                    <ol className="space-y-3 text-sm text-neutral-300">
                      <li className="flex gap-3">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-neutral-400">1</span>
                        <span className="pt-0.5">Open GitHub and enter the one-time code.</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-neutral-400">2</span>
                        <span className="pt-0.5">Approve access, then return here.</span>
                      </li>
                      <li className="flex gap-3">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-semibold text-neutral-400">3</span>
                        <span className="pt-0.5">Check the connection to finish.</span>
                      </li>
                    </ol>

                    <div className="flex gap-2 rounded-lg bg-neutral-900/45 px-3 py-2.5 text-xs leading-5 text-neutral-500">
                      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-neutral-400" />
                      Project Space never asks for your GitHub password.
                    </div>
                  </>
                ) : (
                  <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
                    {isConnecting ? (
                      <LoaderCircle className="size-6 animate-spin text-neutral-400" />
                    ) : (
                      <GitHubMark className="size-7 text-neutral-400" />
                    )}
                    <Text className="block text-sm text-neutral-400">
                      {isConnecting ? 'Preparing your secure GitHub login…' : 'Start a new GitHub login to continue.'}
                    </Text>
                  </div>
                )}
              </Modal.Body>

              <Modal.Footer className="flex-col gap-2 border-t border-neutral-900 px-6 py-4 sm:flex-row sm:justify-end">
                {pendingFlow?.verificationUri ? (
                  <a className="w-full sm:w-auto" href={pendingFlow.verificationUri} target="_blank" rel="noreferrer">
                    <Button className="w-full whitespace-nowrap" size="sm">
                      Open GitHub
                      <ExternalLink className="size-4" />
                    </Button>
                  </a>
                ) : null}
                {isPending ? (
                  <Button
                    className="w-full whitespace-nowrap sm:w-auto"
                    size="sm"
                    variant="secondary"
                    isDisabled={isConnecting}
                    onPress={() => void checkLogin()}
                  >
                    {isConnecting ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                    Check connection
                  </Button>
                ) : !isConnecting ? (
                  <Button className="w-full sm:w-auto" size="sm" onPress={() => void startLogin()}>
                    Try again
                  </Button>
                ) : null}
                <Button
                  className="w-full sm:w-auto"
                  size="sm"
                  variant="ghost"
                  onPress={() => setIsOpen(false)}
                >
                  Cancel
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
