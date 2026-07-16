import { useMemo, useState, type ComponentProps } from 'react';
import { Modal } from '@heroui/react';
import { GitBranch, X } from 'lucide-react';
import {
  Button,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Text
} from '@/app/dotnaos-ui';
import {
  filterMachineBranchOptions,
  orderedMachineBranchOptions,
  previewMachineBranchOptions
} from './project-machine-branch-model';
import { WorktreeBranchList } from './worktree-branch-list';

type BranchListProps = ComponentProps<typeof WorktreeBranchList>;

export function ProjectMachineBranches(props: BranchListProps) {
  const { defaultBranch, options } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const orderedOptions = useMemo(
    () => orderedMachineBranchOptions(options, defaultBranch),
    [defaultBranch, options]
  );
  const previewOptions = useMemo(
    () => previewMachineBranchOptions(orderedOptions, defaultBranch),
    [defaultBranch, orderedOptions]
  );
  const filteredOptions = useMemo(
    () => filterMachineBranchOptions(orderedOptions, query),
    [orderedOptions, query]
  );
  const hiddenCount = Math.max(0, orderedOptions.length - previewOptions.length);

  return (
    <>
      <WorktreeBranchList {...props} options={previewOptions} />
      {hiddenCount > 0 ? (
        <Button
          className="mt-2 w-full justify-center border border-neutral-800 text-neutral-300"
          onPress={() => setOpen(true)}
          size="sm"
          variant="ghost"
        >
          <GitBranch className="size-3.5" />
          View all {orderedOptions.length} branches and worktrees
        </Button>
      ) : null}

      <Modal
        isOpen={open}
        onOpenChange={(isOpen) => {
          setOpen(isOpen);
          if (!isOpen) setQuery('');
        }}
      >
        <Modal.Backdrop variant="blur" className="z-[120] bg-black/75">
          <Modal.Container placement="auto" scroll="inside" size="lg" className="p-0 sm:p-5">
            <Modal.Dialog className="flex h-[min(46rem,calc(100dvh-0.75rem))] max-h-[calc(100dvh-env(safe-area-inset-top)-0.75rem)] w-full max-w-none flex-col rounded-t-[1.75rem] rounded-b-none border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl sm:h-auto sm:max-h-[min(46rem,92dvh)] sm:max-w-3xl sm:rounded-2xl">
              <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-neutral-700 sm:hidden" />
              <Modal.Header className="flex-row items-start gap-3 border-b border-neutral-800 px-5 py-4 sm:px-6">
                <GitBranch className="mt-0.5 size-4 shrink-0 text-neutral-400" />
                <div className="min-w-0 flex-1">
                  <Modal.Heading className="text-base font-semibold text-neutral-100">
                    Project branches
                  </Modal.Heading>
                  <Text className="mt-1 block text-xs text-neutral-500">
                    {orderedOptions.length} branches and registered worktrees on this machine
                  </Text>
                </div>
                <Modal.CloseTrigger aria-label="Close project branches" className="text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100">
                  <X className="size-4" />
                </Modal.CloseTrigger>
              </Modal.Header>
              <Modal.Body className="min-h-0 px-5 py-4 sm:px-6">
                <SearchField
                  aria-label="Search project branches"
                  className="sticky top-0 z-10 mb-3 bg-neutral-950 pb-1"
                  onChange={setQuery}
                  value={query}
                >
                  <SearchFieldGroup className="rounded-lg border border-neutral-800 bg-neutral-900/80">
                    <SearchFieldSearchIcon />
                    <SearchFieldInput className="text-sm" placeholder="Search branches or paths" spellCheck={false} />
                    <SearchFieldClearButton />
                  </SearchFieldGroup>
                </SearchField>
                {filteredOptions.length > 0 ? (
                  <WorktreeBranchList {...props} options={filteredOptions} />
                ) : (
                  <Text className="block py-10 text-center text-sm text-neutral-500">
                    No matching branches.
                  </Text>
                )}
              </Modal.Body>
              <Modal.Footer className="flex-row items-center justify-between border-t border-neutral-800 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">
                <Text className="text-xs text-neutral-500">
                  Showing {filteredOptions.length} of {orderedOptions.length}
                </Text>
                <Button size="sm" variant="secondary" onPress={() => setOpen(false)}>Done</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
