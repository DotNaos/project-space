import { useEffect, useState } from 'react';

import { projectSpaceClient } from '@/api/project-space-client';
import type { PullRequestChangelogIdentity } from '@/shared/pr-preview-changelog-api';

export function usePrototypeReviewBuildIdentity() {
  const [identity, setIdentity] = useState<PullRequestChangelogIdentity>();

  useEffect(() => {
    let active = true;
    void projectSpaceClient.getAppMeta()
      .then((metadata) => {
        if (!active) return;
        setIdentity(
          metadata.preview?.state === 'verified'
            ? metadata.preview.identity
            : undefined
        );
      })
      .catch(() => {
        if (active) setIdentity(undefined);
      });
    return () => {
      active = false;
    };
  }, []);

  return identity;
}
