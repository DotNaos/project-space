import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import type { GitHubBranchRecord } from '@/shared/project-space-api';
import type { GitHubRepositoryTreeResult } from '@/shared/github-repository-tree';
import {
  parseTemplateManifest,
  parseTemplateModule,
  projectTemplateManifestPath,
  projectTemplateRepository,
  resolveTemplateModulePath,
  type TemplateManifest,
  type TemplateModule
} from './template-contract-model';

export interface TemplateContract {
  manifest?: TemplateManifest;
  message?: string;
  modules: TemplateModule[];
}

export function useTemplateBranches() {
  const [branches, setBranches] = useState<GitHubBranchRecord[]>([]);
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let canceled = false;
    setIsLoading(true);
    projectSpaceClient
      .getGitHubRepositoryDetails(projectTemplateRepository)
      .then((result) => {
        if (canceled) return;
        setBranches(result.branches);
        setDefaultBranch(result.branches.find((branch) => branch.isDefault)?.name ?? 'main');
        setError(result.status === 'connected' ? '' : result.message ?? 'The template repository is unavailable.');
      })
      .catch((requestError) => {
        if (!canceled) {
          setError(requestError instanceof Error ? requestError.message : 'Could not load branches.');
        }
      })
      .finally(() => {
        if (!canceled) setIsLoading(false);
      });
    return () => { canceled = true; };
  }, []);

  return { branches, defaultBranch, error, isLoading };
}

export function useTemplateTree(ref: string) {
  const [result, setResult] = useState<GitHubRepositoryTreeResult>();
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!ref) return;
    let canceled = false;
    setIsLoading(true);
    setError('');
    projectSpaceClient
      .getGitHubRepositoryTree(projectTemplateRepository, ref)
      .then((treeResult) => {
        if (canceled) return;
        setResult(treeResult);
        if (treeResult.status !== 'connected') {
          setError(treeResult.message ?? 'The repository tree is unavailable.');
        }
      })
      .catch((requestError) => {
        if (!canceled) {
          setError(requestError instanceof Error ? requestError.message : 'Could not load the tree.');
        }
      })
      .finally(() => {
        if (!canceled) setIsLoading(false);
      });
    return () => { canceled = true; };
  }, [ref]);

  return { error, isLoading, result };
}

export function useTemplateFile(ref: string, path: string) {
  const [content, setContent] = useState<string>();
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!ref || !path) {
      setContent(undefined);
      setMessage('');
      return;
    }
    let canceled = false;
    setIsLoading(true);
    setMessage('');
    setContent(undefined);
    projectSpaceClient
      .getGitHubRepositoryFile(projectTemplateRepository, ref, path)
      .then((result) => {
        if (canceled) return;
        setContent(result.content);
        setMessage(result.message ?? '');
      })
      .catch((requestError) => {
        if (!canceled) {
          setMessage(requestError instanceof Error ? requestError.message : 'Could not load the file.');
        }
      })
      .finally(() => {
        if (!canceled) setIsLoading(false);
      });
    return () => { canceled = true; };
  }, [path, ref]);

  return { content, isLoading, message };
}

/**
 * Reads the manifest on the selected branch and then every module it lists, so
 * the contract view reflects that branch instead of copy held in this repository.
 */
export function useTemplateContract(ref: string) {
  const [contract, setContract] = useState<TemplateContract>({ modules: [] });
  const [isLoading, setIsLoading] = useState(false);
  const selectedRef = useRef(ref);
  selectedRef.current = ref;

  const load = useCallback(async () => {
    if (!ref) return;
    const requestedRef = ref;
    setIsLoading(true);
    try {
      const manifestFile = await projectSpaceClient.getGitHubRepositoryFile(
        projectTemplateRepository,
        ref,
        projectTemplateManifestPath
      );
      if (selectedRef.current !== requestedRef) return;
      if (!manifestFile.content) {
        setContract({
          message: manifestFile.message ?? `No ${projectTemplateManifestPath} on this branch.`,
          modules: []
        });
        return;
      }
      const manifest = parseTemplateManifest(manifestFile.content);
      if (!manifest) {
        setContract({ message: 'The template manifest could not be read.', modules: [] });
        return;
      }
      const modules = await Promise.all(manifest.modulePaths.map(async (modulePath) => {
        const sourcePath = resolveTemplateModulePath(projectTemplateManifestPath, modulePath);
        const file = await projectSpaceClient.getGitHubRepositoryFile(
          projectTemplateRepository,
          ref,
          sourcePath
        );
        return file.content ? parseTemplateModule(file.content, sourcePath) : undefined;
      }));
      if (selectedRef.current !== requestedRef) return;
      setContract({
        manifest,
        modules: modules.flatMap((module) => (module ? [module] : []))
      });
    } catch (error) {
      if (selectedRef.current !== requestedRef) return;
      setContract({
        message: error instanceof Error ? error.message : 'The template contract could not be read.',
        modules: []
      });
    } finally {
      if (selectedRef.current === requestedRef) setIsLoading(false);
    }
  }, [ref]);

  useEffect(() => {
    void load();
  }, [load]);

  return useMemo(() => ({ contract, isLoading, reload: load }), [contract, isLoading, load]);
}
