import type { IssueColumnId } from './issue-board-model';

export interface IssueBoardMoveToken {
  readonly columnId: IssueColumnId;
  readonly issueNumber: number;
}

export class IssueBoardMoveLock {
  private readonly active = new Map<number, IssueBoardMoveToken>();

  begin(issueNumber: number, columnId: IssueColumnId) {
    if (this.active.has(issueNumber)) return null;
    const token = Object.freeze({ columnId, issueNumber });
    this.active.set(issueNumber, token);
    return token;
  }

  clear() {
    this.active.clear();
  }

  finish(token: IssueBoardMoveToken) {
    if (this.active.get(token.issueNumber) !== token) return false;
    this.active.delete(token.issueNumber);
    return true;
  }

  snapshot() {
    return new Map(
      Array.from(this.active, ([issueNumber, token]) => [issueNumber, token.columnId])
    );
  }
}
