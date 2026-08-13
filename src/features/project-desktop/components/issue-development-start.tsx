import { useEffect, useState } from 'react';
import {
  Button as HeroUIButton,
  Input,
  Label,
  Modal,
  TextField
} from '@heroui/react';
import {
  GitBranchPlus,
  GitPullRequestDraft,
  LoaderCircle
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button } from '@/app/dotnaos-ui';
import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord
} from '@/shared/project-space-api';
import { branchNameForIssue } from './issue-branch-model';

interface IssueDevelopmentStartProps {
  canCreatePullRequest?: boolean;
  issue: GitHubIssueRecord;
  linkedBranch?: GitHubBranchRecord;
  onBranchReady(branch: GitHubBranchRecord): void;
  onPullRequestReady(pullRequest: GitHubPullRequestRecord): void;
  recoveryMessage?: string;
  repoFullName?: string;
}

export function IssueDevelopmentStart({
  canCreatePullRequest = false,
  issue,
  linkedBranch,
  onBranchReady,
  onPullRequestReady,
  recoveryMessage,
  repoFullName
}: IssueDevelopmentStartProps) {
  const suggestedBranch = branchNameForIssue(issue);
  const [branchName, setBranchName] = useState(suggestedBranch);
  const [isOpen, setIsOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const isBlockedRecovery = Boolean(recoveryMessage && !linkedBranch);

  useEffect(() => {
    setBranchName(linkedBranch?.name ?? suggestedBranch);
  }, [linkedBranch?.name, recoveryMessage, suggestedBranch]);

  useEffect(() => {
    setMessage('');
    setError('');
    setIsOpen(false);
  }, [issue.number]);

  async function startDevelopment() {
    if (!repoFullName) {
      setError('No GitHub repository is linked.');
      return;
    }
    const requestedBranch = (linkedBranch?.name ?? branchName).trim();
    if (!requestedBranch) {
      setError('Branch name is required.');
      return;
    }

    setIsStarting(true);
    setError('');
    setMessage('');
    try {
      const result = await projectSpaceClient.startGitHubIssueDevelopment({
        branchName: requestedBranch,
        fullName: repoFullName,
        issueNumber: issue.number
      });
      if (result.state !== 'blocked') onBranchReady(result.branch);
      if (result.state === 'ready') {
        if (result.pullRequest) {
          onPullRequestReady(result.pullRequest);
        }
        setMessage(result.message ?? (
          result.pullRequest
            ? `Draft pull request #${result.pullRequest.number} is ready.`
            : `Branch ${result.branch.name} is active.`
        ));
        setIsOpen(false);
        return;
      }
      setError(result.message ?? (
        result.state === 'partial'
          ? 'The branch is ready, but the draft pull request still needs attention.'
          : 'Development setup could not be completed.'
      ));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Development setup could not be completed.');
    } finally {
      setIsStarting(false);
    }
  }

  if (linkedBranch && !canCreatePullRequest && !recoveryMessage && !message) {
    return null;
  }

  return (
    <section className="grid gap-3">
      {recoveryMessage ? <p className="text-xs leading-5 text-amber-300">{recoveryMessage}</p> : null}
      {message ? <p className="text-xs leading-5 text-emerald-300">{message}</p> : null}

      {(!linkedBranch || canCreatePullRequest || isBlockedRecovery) ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-neutral-950/90 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl md:static md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
          <Button
            className="w-full !rounded-full"
            isDisabled={isStarting || !repoFullName}
            onPress={() => setIsOpen(true)}
            size="lg"
            variant="primary"
          >
            {linkedBranch ? <GitPullRequestDraft className="size-4" /> : <GitBranchPlus className="size-4" />}
            {linkedBranch
              ? 'Create Draft PR'
              : isBlockedRecovery
                ? 'Resolve development setup'
                : 'Start development'}
          </Button>
        </div>
      ) : null}

      <Modal
        isOpen={isOpen}
        onOpenChange={(nextOpen) => {
          if (nextOpen || !isStarting) setIsOpen(nextOpen);
        }}
      >
        <Modal.Backdrop
          className="z-[140] bg-black/75"
          isDismissable={!isStarting}
          isKeyboardDismissDisabled={isStarting}
          variant="blur"
        >
          <Modal.Container className="p-4" placement="center" size="sm">
            <Modal.Dialog className="bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/70 sm:max-w-[360px]">
              {!isStarting ? <Modal.CloseTrigger aria-label="Close development setup" /> : null}
              <Modal.Header className="flex-col items-start text-left">
                <Modal.Icon className="bg-blue-500/15 text-blue-400">
                  {linkedBranch
                    ? <GitPullRequestDraft className="size-5" />
                    : <GitBranchPlus className="size-5" />}
                </Modal.Icon>
                <Modal.Heading className="text-xl font-semibold tracking-tight">
                  {linkedBranch
                    ? 'Create Draft PR'
                    : isBlockedRecovery
                      ? 'Resolve development setup'
                      : 'Start development'}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="grid gap-4 !overflow-visible">
                <TextField
                  fullWidth
                  isDisabled={isStarting}
                  isReadOnly={Boolean(linkedBranch) || isBlockedRecovery}
                  onChange={setBranchName}
                  value={linkedBranch?.name ?? branchName}
                >
                  <Label>
                    {linkedBranch ? 'Linked branch' : isBlockedRecovery ? 'Requested branch' : 'New branch'}
                  </Label>
                  <Input
                    autoFocus={!linkedBranch && !isBlockedRecovery}
                    className="w-full font-mono text-xs"
                    variant="secondary"
                  />
                </TextField>

                {recoveryMessage && !error ? <p className="text-xs leading-5 text-amber-300">{recoveryMessage}</p> : null}
                {error ? <p className="text-xs leading-5 text-red-300">{error}</p> : null}
              </Modal.Body>
              <Modal.Footer className="!flex-col gap-2">
                <HeroUIButton
                  className="w-full !rounded-full whitespace-nowrap"
                  isDisabled={isStarting}
                  onPress={() => setIsOpen(false)}
                  size="sm"
                  variant="secondary"
                >
                  Close
                </HeroUIButton>
                <HeroUIButton
                  className="w-full !rounded-full whitespace-nowrap"
                  isDisabled={isStarting || !repoFullName || !(linkedBranch?.name ?? branchName).trim() || Boolean(linkedBranch && !canCreatePullRequest)}
                  size="sm"
                  variant="primary"
                  onPress={() => void startDevelopment()}
                >
                  {isStarting ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  {isStarting
                    ? linkedBranch ? 'Creating Draft PR…' : 'Creating branch…'
                    : linkedBranch
                      ? 'Create Draft PR'
                      : isBlockedRecovery
                        ? 'Retry verification'
                        : 'Create branch'}
                </HeroUIButton>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </section>
  );
}
