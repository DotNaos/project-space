import type { CodexSessionTurnSettings } from '@/shared/codex-sessions-api';
import type { CodexModelRecord } from '@/shared/project-space-api';

export interface CodexSessionModelSelection {
  disabled: boolean;
  effort?: string;
  error?: string;
  loading?: boolean;
  models: CodexModelRecord[];
  onChange(value: string): void;
  onEffortChange(value: string): void;
  onRetry?(): void;
  onServiceTierChange(value: string | null): void;
  onRetry?(): void;
  override?: CodexSessionTurnSettings;
  recoveryCommand?: string;
  recoveryHref?: string;
  serviceTier?: string | null;
  usesCatalogueDefault?: boolean;
  value: string;
}
