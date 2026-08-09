import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ReleaseChangelogEntry } from '@/shared/release-changelog-api';
import {
  buildReleaseVersionTree,
  type ReleaseVersionMajorGroup
} from './release-version-tree';

function selectedBranch(version: string | undefined) {
  const [major, minor] = version?.split('.') ?? [];
  return {
    major,
    minor: major !== undefined && minor !== undefined ? `${major}.${minor}` : undefined
  };
}

export function ReleaseVersionTree({
  releases,
  selectedVersion,
  onSelect
}: {
  releases: ReleaseChangelogEntry[];
  selectedVersion?: string;
  onSelect(version: string): void;
}) {
  const groups = buildReleaseVersionTree(releases);
  const branch = selectedBranch(selectedVersion);
  const [expandedMajors, setExpandedMajors] = useState<Set<string>>(
    () => new Set(branch.major ? [branch.major] : [])
  );
  const [expandedMinors, setExpandedMinors] = useState<Set<string>>(
    () => new Set(branch.minor ? [branch.minor] : [])
  );

  useEffect(() => {
    const next = selectedBranch(selectedVersion);
    if (next.major) {
      setExpandedMajors((current) => new Set(current).add(next.major!));
    }
    if (next.minor) {
      setExpandedMinors((current) => new Set(current).add(next.minor!));
    }
  }, [selectedVersion]);

  return (
    <ul aria-label="Release versions" className="space-y-1" role="tree">
      {groups.map((major) => (
        <MajorTreeItem
          key={major.key}
          expandedMajors={expandedMajors}
          expandedMinors={expandedMinors}
          group={major}
          onSelect={onSelect}
          selectedVersion={selectedVersion}
          setExpandedMajors={setExpandedMajors}
          setExpandedMinors={setExpandedMinors}
        />
      ))}
    </ul>
  );
}

function MajorTreeItem({
  expandedMajors,
  expandedMinors,
  group,
  onSelect,
  selectedVersion,
  setExpandedMajors,
  setExpandedMinors
}: {
  expandedMajors: Set<string>;
  expandedMinors: Set<string>;
  group: ReleaseVersionMajorGroup;
  onSelect(version: string): void;
  selectedVersion?: string;
  setExpandedMajors: Dispatch<SetStateAction<Set<string>>>;
  setExpandedMinors: Dispatch<SetStateAction<Set<string>>>;
}) {
  const expanded = expandedMajors.has(group.key);
  return (
    <li aria-expanded={expanded} role="treeitem">
      <TreeFolderButton
        expanded={expanded}
        label={group.label}
        onPress={() => toggleSet(setExpandedMajors, group.key)}
      />
      {expanded ? (
        <ul className="ml-3 border-l border-white/[.08] pl-2" role="group">
          {group.minors.map((minor) => {
            const minorExpanded = expandedMinors.has(minor.key);
            return (
              <li key={minor.key} aria-expanded={minorExpanded} role="treeitem">
                <TreeFolderButton
                  expanded={minorExpanded}
                  label={minor.label}
                  onPress={() => toggleSet(setExpandedMinors, minor.key)}
                />
                {minorExpanded ? (
                  <ul className="ml-3 border-l border-white/[.08] pl-2" role="group">
                    {minor.releases.map((release) => {
                      const selected = release.version === selectedVersion;
                      return (
                        <li key={release.version} role="treeitem">
                          <button
                            aria-current={selected ? 'page' : undefined}
                            className={cn(
                              'flex min-h-8 w-full items-center rounded-lg px-2 text-left text-xs transition-colors',
                              selected
                                ? 'bg-white/[.08] font-medium text-neutral-100'
                                : 'text-neutral-500 hover:bg-white/[.04] hover:text-neutral-200'
                            )}
                            onClick={() => onSelect(release.version)}
                            type="button"
                          >
                            v{release.version}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

function TreeFolderButton({
  expanded,
  label,
  onPress
}: {
  expanded: boolean;
  label: string;
  onPress(): void;
}) {
  return (
    <button
      className="flex min-h-8 w-full items-center gap-1.5 rounded-lg px-1.5 text-left text-xs font-medium text-neutral-400 transition-colors hover:bg-white/[.04] hover:text-neutral-100"
      onClick={onPress}
      type="button"
    >
      <ChevronRight
        aria-hidden
        className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
      />
      {label}
    </button>
  );
}

function toggleSet(
  setValue: Dispatch<SetStateAction<Set<string>>>,
  key: string
) {
  setValue((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
}
