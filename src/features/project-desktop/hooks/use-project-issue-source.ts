import { useEffect, useState } from 'react';

import type {
  ProjectIssueSourceConfig,
  ProjectSpaceRecord
} from '@/shared/electron-api';

const emptyConfig: ProjectIssueSourceConfig = {
  kind: 'unconfigured',
  source: 'unconfigured',
  url: ''
};

export function useProjectIssueSource(project?: ProjectSpaceRecord) {
  const [config, setConfig] = useState<ProjectIssueSourceConfig>(emptyConfig);
  const [draftKind, setDraftKind] = useState<ProjectIssueSourceConfig['kind']>('unconfigured');
  const [draftUrl, setDraftUrl] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!project) {
      setConfig(emptyConfig);
      setDraftKind('unconfigured');
      setDraftUrl('');
      setError('');
      return;
    }

    let canceled = false;
    setIsLoading(true);

    void window.projectSpace
      .loadProjectIssueSourceConfig(project.rootPath)
      .then((nextConfig) => {
        if (canceled) {
          return;
        }

        setConfig(nextConfig);
        setDraftKind(nextConfig.kind);
        setDraftUrl(nextConfig.url);
        setError('');
      })
      .catch((loadError) => {
        if (canceled) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : 'Could not load project issue source.');
      })
      .finally(() => {
        if (!canceled) {
          setIsLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [project?.rootPath]);

  return {
    config,
    draftKind,
    draftUrl,
    error,
    isLoading,
    isSaving,
    async openSource() {
      if (!config.url.trim()) {
        return;
      }

      const result = await window.projectSpace.openExternalUrl(config.url);

      setError(result.status === 'error' ? result.message ?? 'Could not open the issue source.' : '');
    },
    async save() {
      if (!project || !draftUrl.trim() || draftKind === 'unconfigured') {
        return;
      }

      setIsSaving(true);
      setError('');

      try {
        const nextConfig = await window.projectSpace.saveProjectIssueSourceConfig({
          config: {
            kind: draftKind,
            url: draftUrl.trim()
          },
          projectPath: project.rootPath
        });

        setConfig(nextConfig);
        setDraftKind(nextConfig.kind);
        setDraftUrl(nextConfig.url);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'Could not save the issue source config.');
      } finally {
        setIsSaving(false);
      }
    },
    setDraftKind,
    setDraftUrl
  };
}
