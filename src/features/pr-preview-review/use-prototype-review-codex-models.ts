import { useEffect, useState } from 'react';

import type { CodexSessionModelSelection } from '@/features/codex-sessions/codex-session-model-select';
import type {
  CodexModelCatalogueResult,
  CodexModelRecord
} from '@/shared/project-space-api';

interface ModelState {
  dirty: boolean;
  effort?: string;
  error?: string;
  loading: boolean;
  models: CodexModelRecord[];
  serviceTier?: string | null;
  usesCatalogueDefault: boolean;
  value: string;
}

export function usePrototypeReviewCodexModels(
  enabled: boolean,
  initialModel?: string
): CodexSessionModelSelection {
  const [state, setState] = useState<ModelState>(() => initialState(initialModel));

  useEffect(() => {
    let cancelled = false;
    setState(initialState(initialModel));
    if (!enabled) return () => { cancelled = true; };

    void fetch('/api/prototype-review/codex-models', {
      headers: { Accept: 'application/json' }
    }).then(async (response) => {
      if (!response.ok) throw new Error('Could not load Codex model settings.');
      return await response.json() as CodexModelCatalogueResult;
    }).then((result) => {
      if (cancelled) return;
      if (result.status === 'error' || result.models.length === 0) {
        setState({
          ...initialState(initialModel),
          error: result.message ?? 'Codex returned no available models.',
          loading: false
        });
        return;
      }
      const selected = initialModel
        ? result.models.find((model) => model.model === initialModel)
        : undefined;
      const model = selected ?? result.models.find((entry) => entry.isDefault) ?? result.models[0]!;
      setState({
        dirty: false,
        effort: defaultEffort(model),
        loading: false,
        models: result.models,
        serviceTier: model.defaultServiceTier,
        usesCatalogueDefault: !selected,
        value: model.model
      });
    }).catch((error) => {
      if (cancelled) return;
      setState({
        ...initialState(initialModel),
        error: error instanceof Error ? error.message : 'Could not load Codex models.',
        loading: false
      });
    });

    return () => { cancelled = true; };
  }, [enabled, initialModel]);

  const selectedModel = state.models.find((model) => model.model === state.value);
  return {
    disabled: state.loading || state.models.length === 0,
    effort: state.effort,
    error: state.error,
    models: state.models,
    onChange(value) {
      setState((current) => {
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
        if (!model?.supportedReasoningEfforts?.some(
          (option) => option.reasoningEffort === effort
        )) return current;
        return { ...current, dirty: true, effort, usesCatalogueDefault: false };
      });
    },
    onServiceTierChange(serviceTier) {
      setState((current) => {
        const model = current.models.find((entry) => entry.model === current.value);
        if (!model || serviceTier !== null && !model.serviceTiers?.some(
          (tier) => tier.id === serviceTier
        )) return current;
        return { ...current, dirty: true, serviceTier, usesCatalogueDefault: false };
      });
    },
    override: state.dirty && selectedModel ? {
      ...(state.effort ? { effort: state.effort } : {}),
      model: state.value,
      ...(state.serviceTier !== undefined ? { serviceTier: state.serviceTier } : {})
    } : undefined,
    serviceTier: state.serviceTier,
    usesCatalogueDefault: state.usesCatalogueDefault,
    value: state.value
  };
}

function defaultEffort(model: CodexModelRecord) {
  return model.defaultReasoningEffort
    ?? model.supportedReasoningEfforts?.[0]?.reasoningEffort;
}

function initialState(initialModel?: string): ModelState {
  return {
    dirty: false,
    loading: true,
    models: [],
    usesCatalogueDefault: false,
    value: initialModel ?? ''
  };
}
