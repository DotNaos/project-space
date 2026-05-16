export interface EditTransfer {
  id: string;
  sourceWorktreeId: string;
  targetWorktreeId: string;
  summary: string;
  status: 'draft' | 'validated' | 'applied';
  hunks: Hunk[];
}

export interface Hunk {
  id: string;
  filePath: string;
  header: string;
  addedLines: number;
  removedLines: number;
  selected: boolean;
}

export interface HunkValidationResult {
  hunkId: string;
  valid: boolean;
  message: string;
  conflicts: string[];
}
