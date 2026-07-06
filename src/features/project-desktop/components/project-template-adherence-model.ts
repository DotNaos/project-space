import type {
  TemplateAdherenceEntry,
  TemplateAdherenceEntryStatus
} from '@/shared/project-space-api';

export const statusSeverity: Record<TemplateAdherenceEntryStatus, number> = {
  OK: 0,
  ADDED: 1,
  WAIVED: 2,
  CHANGED: 3,
  MISSING: 4,
  VIOLATION: 5
};

export const statusLabels: Record<TemplateAdherenceEntryStatus, string> = {
  OK: 'OK',
  ADDED: 'Added',
  WAIVED: 'Waived',
  CHANGED: 'Changed',
  MISSING: 'Missing',
  VIOLATION: 'Violation'
};

export const statusTextClass: Record<TemplateAdherenceEntryStatus, string> = {
  OK: 'text-emerald-300',
  ADDED: 'text-sky-300',
  WAIVED: 'text-neutral-400',
  CHANGED: 'text-amber-300',
  MISSING: 'text-amber-300',
  VIOLATION: 'text-red-300'
};

export const statusDotClass: Record<TemplateAdherenceEntryStatus, string> = {
  OK: 'bg-emerald-400',
  ADDED: 'bg-sky-400',
  WAIVED: 'bg-neutral-500',
  CHANGED: 'bg-amber-400',
  MISSING: 'bg-amber-400',
  VIOLATION: 'bg-red-400'
};

const ruleCodeExplanations: Record<string, string> = {
  blocker: 'File blocks template adoption and must be removed or waived.',
  missing: 'Required template file is missing from the project.',
  not_allowed: 'File is not part of the template and matches no slot rule.',
  slot: 'File is accepted through a template slot rule.',
  template: 'File is owned and checked by the template.',
  waived: 'Violation is explicitly waived in the template lock.'
};

export interface AdherenceTreeNode {
  children: AdherenceTreeNode[];
  entry?: TemplateAdherenceEntry;
  issueCount: number;
  name: string;
  path: string;
  worstStatus: TemplateAdherenceEntryStatus;
}

export function entryStatusNote(entry: TemplateAdherenceEntry) {
  if (entry.note && entry.note !== entry.code) {
    return entry.note;
  }

  return entry.code ? ruleCodeExplanations[entry.code] ?? entry.code : undefined;
}

export function isIssueStatus(status: TemplateAdherenceEntryStatus) {
  return status === 'VIOLATION' || status === 'MISSING' || status === 'CHANGED';
}

export function buildAdherenceTree(entries: TemplateAdherenceEntry[]): AdherenceTreeNode[] {
  interface MutableNode {
    children: Map<string, MutableNode>;
    entry?: TemplateAdherenceEntry;
    name: string;
    path: string;
  }

  const root: MutableNode = { children: new Map(), name: '', path: '' };

  for (const entry of entries) {
    let node = root;

    for (const segment of entry.path.split('/')) {
      let child = node.children.get(segment);

      if (!child) {
        child = {
          children: new Map(),
          name: segment,
          path: node.path ? `${node.path}/${segment}` : segment
        };
        node.children.set(segment, child);
      }

      node = child;
    }

    node.entry = entry;
  }

  function finalize(node: MutableNode): AdherenceTreeNode {
    const children = [...node.children.values()].map(finalize).sort((left, right) => {
      const leftIsDir = left.children.length > 0;
      const rightIsDir = right.children.length > 0;

      if (leftIsDir !== rightIsDir) {
        return leftIsDir ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
    const ownStatus = node.entry?.status ?? 'OK';
    let worstStatus = ownStatus;
    let issueCount = node.entry && isIssueStatus(ownStatus) ? 1 : 0;

    for (const child of children) {
      if (statusSeverity[child.worstStatus] > statusSeverity[worstStatus]) {
        worstStatus = child.worstStatus;
      }

      issueCount += child.issueCount;
    }

    return {
      children,
      entry: node.entry,
      issueCount,
      name: node.name,
      path: node.path,
      worstStatus
    };
  }

  return finalize(root).children;
}

export function filterTree(
  nodes: AdherenceTreeNode[],
  matches: (node: AdherenceTreeNode) => boolean
): AdherenceTreeNode[] {
  const filtered: AdherenceTreeNode[] = [];

  for (const node of nodes) {
    const children = filterTree(node.children, matches);

    if (children.length > 0 || matches(node)) {
      filtered.push({ ...node, children });
    }
  }

  return filtered;
}

export function collectDirectoryPaths(nodes: AdherenceTreeNode[], into: Set<string>) {
  for (const node of nodes) {
    if (node.children.length > 0) {
      into.add(node.path);
      collectDirectoryPaths(node.children, into);
    }
  }
}

export function collectIssueDirectoryPaths(nodes: AdherenceTreeNode[], into: Set<string>) {
  for (const node of nodes) {
    if (node.children.length > 0 && node.issueCount > 0) {
      into.add(node.path);
      collectIssueDirectoryPaths(node.children, into);
    }
  }
}
