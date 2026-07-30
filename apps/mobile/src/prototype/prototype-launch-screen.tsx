import { useEffect, useMemo, useState } from 'react';

import { Button, Chip, Spinner, useThemeColor } from 'heroui-native';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import Bot from 'lucide-react-native/icons/bot';
import CircleDot from 'lucide-react-native/icons/circle-dot';
import ExternalLink from 'lucide-react-native/icons/external-link';
import FolderGit2 from 'lucide-react-native/icons/folder-git-2';
import GitPullRequest from 'lucide-react-native/icons/git-pull-request';
import MessageSquarePlus from 'lucide-react-native/icons/message-square-plus';
import Monitor from 'lucide-react-native/icons/monitor';
import Play from 'lucide-react-native/icons/play';
import Smartphone from 'lucide-react-native/icons/smartphone';
import {
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  prototypeIdentityLinks,
  type PrototypeLaunchIdentity,
  type PrototypeLaunchState,
} from '../../../../src/shared/prototype-launch';
import {
  NATIVE_PROTOTYPE_STATE_OPTIONS,
  nativePrototypeCapabilities,
  nativePrototypePrimaryAction,
  nativePrototypeStateDescription,
  shortNativePrototypeSha,
  type NativePrototypeContext,
  type NativePrototypeSurfaceMode,
} from './prototype-launch-native-state';

interface PrototypeLaunchScreenProps {
  identity?: PrototypeLaunchIdentity;
  initialState?: PrototypeLaunchState;
  onOpenLink?(href: string): void;
}

type IconComponent = typeof CircleDot;

const stateChipColor: Record<
  PrototypeLaunchState,
  'accent' | 'danger' | 'default' | 'success' | 'warning'
> = {
  'not-started': 'default',
  starting: 'accent',
  ready: 'success',
  stale: 'warning',
  unavailable: 'danger',
  stopped: 'default',
};

function IdentityRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <View className="min-w-0 border-b border-separator py-3 last:border-b-0">
      <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </Text>
      <Text
        className="mt-1 text-sm font-medium text-foreground"
        numberOfLines={2}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

function NavigationButton({
  active,
  disabled,
  icon: Icon,
  label,
  onPress,
}: {
  active?: boolean;
  disabled?: boolean;
  icon: IconComponent;
  label: string;
  onPress(): void;
}) {
  const iconColor = useThemeColor(active ? 'accent-foreground' : 'foreground');
  return (
    <Button
      accessibilityLabel={`Open ${label}`}
      className="min-w-0 basis-[47%] grow"
      isDisabled={disabled}
      size="sm"
      variant={active ? 'primary' : 'secondary'}
      onPress={onPress}
    >
      <Icon color={iconColor} size={16} />
      <Button.Label className="min-w-0 text-xs" numberOfLines={1}>
        {label}
      </Button.Label>
    </Button>
  );
}

function ContextHeader({
  context,
  identity,
  onBack,
}: {
  context: NativePrototypeContext;
  identity?: PrototypeLaunchIdentity;
  onBack(): void;
}) {
  const accent = useThemeColor('accent');
  const foreground = useThemeColor('foreground');

  if (context !== 'prototype') {
    return (
      <>
        <Text className="text-xs font-semibold uppercase tracking-[1.4px] text-muted">
          {identity?.repositoryFullName ?? 'Prototype identity unavailable'}
        </Text>
        <View className="mt-3 flex-row items-center gap-2">
          {context === 'issue' ? (
            <CircleDot color={accent} size={20} />
          ) : (
            <GitPullRequest color={accent} size={20} />
          )}
          <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground">
            {context === 'issue'
              ? identity?.issueNumber
                ? `Issue #${identity.issueNumber}`
                : 'Issue unavailable'
              : identity?.pullRequestNumber
                ? `Pull request #${identity.pullRequestNumber}`
                : 'Pull request unavailable'}
          </Text>
        </View>
        <Text className="mt-3 text-[26px] font-semibold leading-8 text-foreground">
          Start and navigate issue/PR prototypes
        </Text>
      </>
    );
  }

  return (
    <>
      <Button
        accessibilityLabel="Back to issue"
        className="self-start"
        size="sm"
        variant="ghost"
        onPress={onBack}
      >
        <ArrowLeft color={foreground} size={16} />
        <Button.Label>Back to issue</Button.Label>
      </Button>
      <Text className="mt-4 text-xs font-semibold uppercase tracking-[1.4px] text-muted">
        Prototype review
      </Text>
      <Text className="mt-3 text-[26px] font-semibold leading-8 text-foreground">
        Mobile launch workflow
      </Text>
    </>
  );
}

export function PrototypeLaunchScreen({
  identity,
  initialState = 'ready',
  onOpenLink,
}: PrototypeLaunchScreenProps) {
  const safeArea = useSafeAreaInsets();
  const [context, setContext] = useState<NativePrototypeContext>('issue');
  const [launchState, setLaunchState] =
    useState<PrototypeLaunchState>(identity ? initialState : 'unavailable');
  const [surfaceMode, setSurfaceMode] =
    useState<NativePrototypeSurfaceMode>('local');
  const [notice, setNotice] = useState(
    'Exact repository, pull request, and head are linked.'
  );
  const capabilities = useMemo(
    () => nativePrototypeCapabilities(surfaceMode),
    [surfaceMode]
  );
  const primaryAction = nativePrototypePrimaryAction(launchState);
  const shortSha = identity
    ? shortNativePrototypeSha(identity.headSha)
    : 'unverified';
  const links = useMemo(
    () => identity ? prototypeIdentityLinks(identity) : undefined,
    [identity]
  );
  const foreground = useThemeColor('foreground');
  const accentForeground = useThemeColor('accent-foreground');

  const startPrototype = () => {
    if (launchState === 'ready') {
      setContext('prototype');
      setNotice(`Opened the verified Expo Go surface at ${shortSha}.`);
      return;
    }
    if (links?.issue && onOpenLink) {
      onOpenLink(links.issue);
      setNotice(`Opened the trusted Project Space start flow at ${shortSha}.`);
      return;
    }
    setNotice('A verified issue identity is required before starting a prototype.');
  };

  useEffect(() => {
    setLaunchState(identity ? initialState : 'unavailable');
    setNotice(identity
      ? 'Exact repository, pull request, and head are linked.'
      : 'The launch URL does not contain a complete prototype identity.');
  }, [identity, initialState]);

  const chooseState = (state: PrototypeLaunchState) => {
    if (!identity) return;
    setLaunchState(state);
    setNotice(nativePrototypeStateDescription(state));
  };

  const navigate = (
    nextContext: NativePrototypeContext,
    destination: string,
    href?: string
  ) => {
    setContext(nextContext);
    if (href && onOpenLink) onOpenLink(href);
    setNotice(`Opened the exact ${destination} context.`);
  };

  return (
    <View className="min-h-0 flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(safeArea.bottom, 20) + 28,
          paddingHorizontal: 18,
          paddingTop: Math.max(safeArea.top, 20) + 8,
        }}
        showsVerticalScrollIndicator={false}
      >
        <ContextHeader
          context={context}
          identity={identity}
          onBack={() => navigate('issue', 'issue', links?.issue)}
        />

        <View className="mt-5 flex-row flex-wrap gap-2">
          <Button
            className="min-w-0 grow"
            size="sm"
            variant={surfaceMode === 'local' ? 'primary' : 'secondary'}
            onPress={() => {
              setSurfaceMode('local');
              setNotice('Verified local session selected.');
            }}
          >
            <Smartphone
              color={surfaceMode === 'local' ? accentForeground : foreground}
              size={15}
            />
            <Button.Label className="text-xs">Local session</Button.Label>
          </Button>
          <Button
            className="min-w-0 grow"
            size="sm"
            variant={surfaceMode === 'deployed' ? 'primary' : 'secondary'}
            onPress={() => {
              setSurfaceMode('deployed');
              setNotice('Read-only deployed PR preview selected.');
            }}
          >
            <ExternalLink
              color={surfaceMode === 'deployed' ? accentForeground : foreground}
              size={15}
            />
            <Button.Label className="text-xs">PR preview</Button.Label>
          </Button>
        </View>

        <View className="mt-4 rounded-[20px] border border-separator bg-surface px-4 py-4">
          <View className="flex-row items-center justify-between gap-3">
            <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground">
              {surfaceMode === 'local'
                ? 'Verified local session'
                : 'Deployed PR preview'}
            </Text>
            <Chip
              color={surfaceMode === 'local' ? 'success' : 'default'}
              size="sm"
              variant="soft"
            >
              {capabilities.readOnly ? 'Read only' : 'Feedback on'}
            </Chip>
          </View>
          <Text className="mt-2 text-sm leading-5 text-muted">
            {surfaceMode === 'local'
              ? 'Codex feedback and annotations are available only through this verified development session.'
              : 'No Codex, terminal, Git, connector, or machine capability is exposed to deployed code.'}
          </Text>
        </View>

        <View className="mt-5">
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-lg font-semibold text-foreground">
              Prototype state
            </Text>
            <Chip
              color={stateChipColor[launchState]}
              size="sm"
              variant="soft"
            >
              {NATIVE_PROTOTYPE_STATE_OPTIONS.find(
                (option) => option.state === launchState
              )?.label}
            </Chip>
          </View>
          <Text className="mt-2 text-sm leading-5 text-muted">
            {nativePrototypeStateDescription(launchState)}
          </Text>
          <View className="mt-4 flex-row flex-wrap gap-2">
            {NATIVE_PROTOTYPE_STATE_OPTIONS.map((option) => (
              <Button
                key={option.state}
                accessibilityLabel={`Show ${option.label} state`}
                className="min-w-0 basis-[47%] grow"
                size="sm"
                variant={
                  option.state === launchState ? 'primary' : 'secondary'
                }
                onPress={() => chooseState(option.state)}
              >
                <Button.Label className="text-xs" numberOfLines={1}>
                  {option.label}
                </Button.Label>
              </Button>
            ))}
          </View>
        </View>

        <View className="mt-5 rounded-[20px] bg-surface-secondary px-4 py-1">
          <IdentityRow
            label="Repository"
            value={identity?.repositoryFullName ?? 'Unavailable'}
          />
          <IdentityRow
            label="Issue / pull request"
            value={`${identity?.issueNumber ? `#${identity.issueNumber}` : 'Unavailable'} / #${identity?.pullRequestNumber ?? 'Unavailable'}`}
          />
          <IdentityRow
            label="Exact head"
            value={`${shortSha} · ${identity?.branchName ?? 'branch unavailable'}`}
          />
          <IdentityRow
            label="Task / worktree"
            value={`${identity?.threadId ?? 'Task unavailable'} · ${identity?.worktreeId ?? 'Worktree unavailable'}`}
          />
          <IdentityRow
            label="Machine / surface"
            value={`${identity?.machineId ?? 'Machine unavailable'} · Expo Go`}
          />
        </View>

        <View className="mt-5">
          <Button
            accessibilityLabel={primaryAction.label}
            isDisabled={primaryAction.disabled || !identity}
            variant="primary"
            onPress={startPrototype}
          >
            {launchState === 'starting' ? (
              <Spinner color={accentForeground} size="sm" />
            ) : (
              <Play color={accentForeground} size={18} />
            )}
            <Button.Label>{primaryAction.label}</Button.Label>
          </Button>
          {context === 'prototype' && capabilities.codexFeedback ? (
            <Button
              className="mt-2"
              variant="secondary"
              onPress={() =>
                setNotice('Feedback composer opened for the owning Codex task.')
              }
            >
              <MessageSquarePlus color={foreground} size={17} />
              <Button.Label>Add feedback to Codex</Button.Label>
            </Button>
          ) : null}
        </View>

        <View className="mt-6">
          <Text className="text-sm font-semibold text-foreground">
            Linked context
          </Text>
          <View className="mt-3 flex-row flex-wrap gap-2">
            <NavigationButton
              active={context === 'issue'}
              disabled={!links?.issue}
              icon={CircleDot}
              label="Issue"
              onPress={() => navigate('issue', 'issue', links?.issue)}
            />
            <NavigationButton
              active={context === 'pull-request'}
              disabled={!links?.pullRequest}
              icon={GitPullRequest}
              label="Pull request"
              onPress={() =>
                navigate('pull-request', 'pull request', links?.pullRequest)
              }
            />
            <NavigationButton
              icon={Bot}
              label="Codex task"
              disabled={!links?.task}
              onPress={() => {
                if (links?.task && onOpenLink) onOpenLink(links.task);
                setNotice('Opened the exact owning Codex task.');
              }}
            />
            <NavigationButton
              icon={FolderGit2}
              label="Worktree"
              disabled={!links?.worktree}
              onPress={() => {
                if (links?.worktree && onOpenLink) onOpenLink(links.worktree);
                setNotice('Opened the exact Project-managed worktree.');
              }}
            />
            <NavigationButton
              icon={Monitor}
              label="Machine"
              disabled={!links?.machine}
              onPress={() => {
                if (links?.machine && onOpenLink) onOpenLink(links.machine);
                setNotice('Opened the exact running machine.');
              }}
            />
            <NavigationButton
              active={context === 'prototype'}
              icon={Smartphone}
              label="Prototype"
              onPress={() => {
                if (launchState === 'ready') {
                  navigate('prototype', 'prototype');
                } else {
                  setNotice('Start a verified prototype before opening it.');
                }
              }}
            />
          </View>
        </View>

        <View
          accessibilityLiveRegion="polite"
          className="mt-5 flex-row items-start gap-2 rounded-[16px] bg-default px-3 py-3"
        >
          <ExternalLink color={foreground} size={15} />
          <Text className="min-w-0 flex-1 text-xs leading-5 text-default-foreground">
            {notice}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
