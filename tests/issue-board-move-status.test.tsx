import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { IssueBoardMoveStatus } from '../src/features/project-desktop/components/issue-board-move-status';

describe('issue board move status', () => {
  test('keeps a failed move recoverable and announces its GitHub error', () => {
    const html = renderToStaticMarkup(
      <IssueBoardMoveStatus
        isRetrying={false}
        message="GitHub rejected the update."
        onDismiss={() => undefined}
        onRetry={() => undefined}
      />
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('GitHub rejected the update.');
    expect(html).toContain('Retry');
    expect(html).toContain('Dismiss issue move error');
  });
});
