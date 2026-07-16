import { useEffect, useState } from 'react';
import { projectSpaceClient } from '../../api/project-space-client';
import type { CodexModelRecord } from '@/shared/project-space-api';
import type { CodexSession } from './codex-sessions-types';
import type { CodexSessionModelSelection } from './codex-session-model-select';

type ModelState = {
  error?: string;
  key: string;
  loading: boolean;
  models: CodexModelRecord[];
  override?: string;
  value: string;
};

export function useCodexSessionModels(
  session: CodexSession,
  enabled: boolean
): CodexSessionModelSelection {
  const key = `${session.machineId}\u0000${session.threadId}`;
  const [state, setState] = useState<ModelState>(() => initialState(key, session.model));

  useEffect(() => {
    let cancelled = false;
    setState(initialState(key, session.model));

    if (!enabled) {
      setState({
        ...initialState(key, session.model),
        error: 'Update this machine connector to select a model.',
        loading: false
      });
      return () => { cancelled = true; };
    }

    if (!session.cwd) {
      setState({
        ...initialState(key, session.model),
        error: 'This task has no verified working directory for model discovery.',
        loading: false
      });
      return () => { cancelled = true; };
    }

    void projectSpaceClient.getCodexModels({
      cwd: session.cwd,
      machineId: session.machineId
    }).then((result) => {
      if (cancelled) return;
      if (result.status === 'error' || result.models.length === 0) {
        setState({
          ...initialState(key, session.model),
          error: result.message ?? 'Codex returned no available models.',
          loading: false
        });
        return;
      }
      setState({
        key,
        loading: false,
        models: result.models,
        value: session.model
          ?? (result.models.find((model) => model.isDefault) ?? result.models[0]).model
      });
    }).catch((loadError) => {
      if (!cancelled) {
        setState({
          ...initialState(key, session.model),
          error: loadError instanceof Error ? loadError.message : 'Could not load Codex models.',
          loading: false
        });
      }
    });

    return () => { cancelled = true; };
  }, [enabled, key, session.cwd, session.machineId, session.model]);

  if (state.key !== key) {
    const current = initialState(key, session.model);
    return {
      disabled: true,
      models: current.models,
      onChange: () => {},
      value: current.value
    };
  }

  return {
    disabled: state.loading || state.models.length === 0,
    error: state.error,
    models: state.models,
    onChange(value) {
      setState((current) => current.key === key
        ? { ...current, override: value, value }
        : current);
    },
    override: state.override,
    value: state.value
  };
}

function initialState(key: string, model?: string): ModelState {
  return { key, loading: true, models: [], value: model ?? '' };
}
