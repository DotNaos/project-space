import { useEffect, useState } from 'react';
import { projectSpaceClient } from '../../api/project-space-client';
import type { CodexModelRecord } from '@/shared/project-space-api';
import type { CodexSession } from './codex-sessions-types';
import type { CodexSessionModelSelection } from './codex-session-model-select';

type ModelState = {
  dirty: boolean;
  effort?: string;
  error?: string;
  key: string;
  loading: boolean;
  models: CodexModelRecord[];
  serviceTier?: string | null;
  usesCatalogueDefault: boolean;
  value: string;
};

export function useCodexSessionModels(
  session: CodexSession,
  enabled: boolean,
  unavailable: {
    command?: string;
    href?: string;
    reason?: string;
  } = {}
): CodexSessionModelSelection {
  const key = `${session.machineId}\u0000${session.threadId}`;
  const [state, setState] = useState<ModelState>(() => initialState(key, session.model));
  const [retryRevision, setRetryRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState(initialState(key, session.model));

    if (!enabled) {
      setState({
        ...initialState(key, session.model),
        error: unavailable.reason ??
          'Update this machine connector to select model settings.',
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
        dirty: false,
        key,
        loading: false,
        models: result.models,
        usesCatalogueDefault: !session.model,
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
  }, [enabled, key, retryRevision, session.cwd, session.machineId, session.model,
    unavailable.reason]);

  if (state.key !== key) {
    return disabledSelection(key, session.model);
  }

  const selectedModel = state.models.find((model) => model.model === state.value);
  return {
    disabled: state.loading || state.models.length === 0,
    effort: state.effort,
    error: state.error,
    loading: state.loading,
    models: state.models,
    onChange(value) {
      setState((current) => {
        if (current.key !== key) return current;
        const model = current.models.find((entry) => entry.model === value);
        if (!model) return current;
        return {
          ...current,
          dirty: true,
          effort: defaultEffort(model),
          serviceTier: model.defaultServiceTier,
          usesCatalogueDefault: false,
          value
        };
      });
    },
    onEffortChange(effort) {
      setState((current) => {
        const model = current.models.find((entry) => entry.model === current.value);
        if (current.key !== key || !model ||
          !model.supportedReasoningEfforts?.some((option) => option.reasoningEffort === effort)) {
          return current;
        }
        return { ...current, dirty: true, effort, usesCatalogueDefault: false };
      });
    },
    onServiceTierChange(serviceTier) {
      setState((current) => {
        const model = current.models.find((entry) => entry.model === current.value);
        if (current.key !== key || !model || serviceTier !== null &&
          !model.serviceTiers?.some((tier) => tier.id === serviceTier)) {
          return current;
        }
        return { ...current, dirty: true, serviceTier, usesCatalogueDefault: false };
      });
    },
    onRetry: state.error && enabled && session.cwd
      ? () => setRetryRevision((revision) => revision + 1)
      : undefined,
    override: state.dirty && selectedModel ? {
      ...(state.effort ? { effort: state.effort } : {}),
      model: state.value,
      ...(state.serviceTier !== undefined ? { serviceTier: state.serviceTier } : {})
    } : undefined,
    recoveryCommand: !enabled ? unavailable.command : undefined,
    recoveryHref: !enabled ? unavailable.href : undefined,
    serviceTier: state.serviceTier,
    usesCatalogueDefault: state.usesCatalogueDefault,
    value: state.value
  };
}

function defaultEffort(model: CodexModelRecord) {
  return model.defaultReasoningEffort
    ?? model.supportedReasoningEfforts?.[0]?.reasoningEffort;
}

function disabledSelection(key: string, model?: string): CodexSessionModelSelection {
  const current = initialState(key, model);
  return {
    disabled: true,
    models: current.models,
    onChange: () => {},
    onEffortChange: () => {},
    onServiceTierChange: () => {},
    value: current.value
  };
}

function initialState(key: string, model?: string): ModelState {
  return {
    dirty: false,
    key,
    loading: true,
    models: [],
    usesCatalogueDefault: false,
    value: model ?? ''
  };
}
