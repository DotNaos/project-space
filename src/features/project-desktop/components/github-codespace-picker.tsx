import { Label, Radio, RadioGroup } from '@heroui/react';
import { Plus } from 'lucide-react';
import type { GitHubCodespaceRunnerResult } from '@/shared/github-codespace-runner-api';

type CodespaceChoice = NonNullable<GitHubCodespaceRunnerResult['codespaces']>[number];

interface CodespaceStatusPresentation {
  dotClassName: string;
  label: string;
  textClassName: string;
}

interface GitHubCodespacePickerProps {
  codespaces: CodespaceChoice[];
  isDisabled?: boolean;
  onChange(codespaceName?: string): void;
  value?: string;
}

export function preserveCodespaceChoices(
  next: GitHubCodespaceRunnerResult,
  current?: GitHubCodespaceRunnerResult
) {
  if (next.codespaces !== undefined || current?.codespaces === undefined) return next;
  return { ...next, codespaces: current.codespaces };
}

export function githubCodespaceLaunchAction(
  runner: GitHubCodespaceRunnerResult | undefined,
  selectedCodespaceName: string | undefined
): 'provision' | 'start' | 'status' | undefined {
  if (!runner) return undefined;
  if (!selectedCodespaceName) {
    return runner.state === 'not-created' ? 'provision' : undefined;
  }
  if (runner.codespace?.name !== selectedCodespaceName || runner.state === 'failed') {
    return undefined;
  }
  return runner.state === 'offline' || runner.codespace.state.toLowerCase() === 'shutdown'
    ? 'start'
    : 'status';
}

const createValue = 'create-new';
const existingPrefix = 'existing:';

function choiceValue(codespaceName: string) {
  return `${existingPrefix}${codespaceName}`;
}

export function codespaceStatusPresentation(state: string): CodespaceStatusPresentation {
  switch (state.toLowerCase()) {
    case 'available':
      return {
        dotClassName: 'bg-emerald-400',
        label: 'Online',
        textClassName: 'text-emerald-300'
      };
    case 'shutdown':
      return {
        dotClassName: 'bg-neutral-500',
        label: 'Offline',
        textClassName: 'text-neutral-400'
      };
    case 'starting':
    case 'rebuilding':
    case 'provisioning':
    case 'queued':
      return {
        dotClassName: 'bg-sky-400 animate-pulse',
        label: 'Starting',
        textClassName: 'text-sky-300'
      };
    case 'shuttingdown':
    case 'stopping':
      return {
        dotClassName: 'bg-amber-400 animate-pulse',
        label: 'Stopping',
        textClassName: 'text-amber-300'
      };
    case 'failed':
    case 'unavailable':
      return {
        dotClassName: 'bg-red-400',
        label: 'Error',
        textClassName: 'text-red-300'
      };
    default:
      return {
        dotClassName: 'bg-neutral-500',
        label: state,
        textClassName: 'text-neutral-400'
      };
  }
}

function RadioControl() {
  return (
    <Radio.Control className="size-5 shrink-0 !rounded-full">
      <Radio.Indicator className="!rounded-full">
        {({ isSelected }) => (
          <span className={`size-2 rounded-full bg-white transition-transform ${
            isSelected ? 'scale-100' : 'scale-0'
          }`} />
        )}
      </Radio.Indicator>
    </Radio.Control>
  );
}

export function GitHubCodespacePicker({
  codespaces,
  isDisabled = false,
  onChange,
  value
}: GitHubCodespacePickerProps) {
  return (
    <RadioGroup
      className="w-full min-w-0 gap-0"
      isDisabled={isDisabled}
      name="github-codespace"
      onChange={(nextValue) => onChange(
        nextValue === createValue
          ? undefined
          : nextValue.slice(existingPrefix.length)
      )}
      value={value ? choiceValue(value) : createValue}
      variant="secondary"
    >
      <Label className="sr-only">GitHub Codespace</Label>
      <Radio className="!mt-0 w-full min-w-0" value={createValue}>
        <Radio.Content className="min-h-10 w-full min-w-0 !flex-row items-center gap-2.5 bg-transparent px-3 py-2">
          <RadioControl />
          <Plus aria-hidden className="size-3.5 shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1 truncate text-xs font-bold text-neutral-100">
            Create a new Codespace
          </span>
        </Radio.Content>
      </Radio>
      {codespaces.map((codespace) => (
          <Radio
            aria-label={codespace.name}
            className="!mt-0 w-full min-w-0 border-t border-white/[.06]"
            key={codespace.name}
            value={choiceValue(codespace.name)}
          >
            <Radio.Content className="min-h-10 w-full min-w-0 !flex-row items-center gap-2.5 bg-transparent px-3 py-2">
              <RadioControl />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-200">
                {codespace.name}
              </span>
            </Radio.Content>
          </Radio>
      ))}
    </RadioGroup>
  );
}
