import { Button } from 'heroui-native';
import type { LucideIcon } from 'lucide-react-native';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronsUpDown from 'lucide-react-native/icons/chevrons-up-down';
import Ellipsis from 'lucide-react-native/icons/ellipsis';
import GitFork from 'lucide-react-native/icons/git-fork';
import PanelLeft from 'lucide-react-native/icons/panel-left';
import Search from 'lucide-react-native/icons/search';
import SquarePen from 'lucide-react-native/icons/square-pen';
import type { ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type PressableProps,
} from 'react-native';

export const workflowColors = {
  background: '#000000',
  danger: '#ff453a',
  good: '#30d158',
  muted: '#98989d',
  panel: '#1c1c1e',
  raised: '#2c2c2e',
  text: '#f5f5f7',
  white: '#ffffff',
} as const;

export function WorkflowIcon({
  color = workflowColors.text,
  icon: Icon,
  size = 18,
}: {
  color?: string;
  icon: LucideIcon;
  size?: number;
}) {
  return <Icon color={color} size={size} strokeWidth={1.8} />;
}

export function RoundIconButton({
  accessibilityLabel,
  icon,
  onPress,
}: {
  accessibilityLabel: string;
  icon: LucideIcon;
  onPress(): void;
}) {
  return (
    <Button
      accessibilityLabel={accessibilityLabel}
      className="h-10 w-10 rounded-full bg-[#1c1c1e] px-0 outline-none"
      feedbackVariant="scale"
      isIconOnly
      onPress={onPress}
      variant="ghost"
    >
      <WorkflowIcon icon={icon} />
    </Button>
  );
}

export function WorkflowHeader({
  onOpenInfo,
  onOpenSidebar,
  subtitle = 'project-space',
  title,
}: {
  onOpenInfo(): void;
  onOpenSidebar(): void;
  subtitle?: string;
  title: string;
}) {
  return (
    <View className="h-16 flex-row items-center gap-3 px-4">
      <RoundIconButton
        accessibilityLabel="Open sidebar"
        icon={PanelLeft}
        onPress={onOpenSidebar}
      />
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-[#f5f5f7]" numberOfLines={1}>
          {title}
        </Text>
        <Text className="mt-0.5 text-[11px] text-[#98989d]" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <RoundIconButton
        accessibilityLabel="View page information"
        icon={Ellipsis}
        onPress={onOpenInfo}
      />
    </View>
  );
}

export function BackRow({
  label,
  onPress,
}: {
  label: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className="h-10 flex-row items-center gap-2 px-4"
      onPress={onPress}
    >
      <WorkflowIcon color={workflowColors.muted} icon={ChevronLeft} size={16} />
      <Text className="text-xs font-semibold text-[#98989d]">{label}</Text>
    </Pressable>
  );
}

export function ScreenScroll({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="pb-4"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
}

export function SectionTitle({
  action,
  icon,
  title,
}: {
  action?: ReactNode;
  icon?: LucideIcon;
  title: string;
}) {
  return (
    <View className="flex-row items-center gap-2 px-5 pb-3 pt-4">
      {icon ? <WorkflowIcon icon={icon} size={17} /> : null}
      <Text className="text-[16px] font-bold text-[#f5f5f7]">{title}</Text>
      {action ? <View className="ml-auto">{action}</View> : null}
    </View>
  );
}

export function FlatGroup({ children }: { children: ReactNode }) {
  return <View className="mx-4 overflow-hidden rounded-[24px] bg-[#1c1c1e]">{children}</View>;
}

export function FlatRow({
  children,
  onPress,
}: {
  children: ReactNode;
  onPress?: PressableProps['onPress'];
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      className="min-h-14 flex-row items-center gap-3 border-b border-[#38383a]/60 px-4 py-3 last:border-b-0"
      onPress={onPress}
    >
      {children}
    </Pressable>
  );
}

export function SegmentedControl({
  options,
  selected,
}: {
  options: readonly {
    label: string;
    onPress(): void;
    value: string;
  }[];
  selected: string;
}) {
  return (
    <View className="flex-row rounded-full bg-[#1c1c1e] p-1">
      {options.map((option) => {
        const active = option.value === selected;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            className={`rounded-full px-4 py-2 ${
              active ? 'bg-[#2c2c2e]' : ''
            }`}
            key={option.value}
            onPress={option.onPress}
          >
            <Text
              className={`text-xs font-medium ${
                active ? 'text-white' : 'text-[#98989d]'
              }`}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function WorkflowGate({
  active,
  label,
  options,
}: {
  active: string;
  label: string;
  options: readonly {
    label: string;
    onPress(): void;
    value: string;
  }[];
}) {
  return (
    <View className="mx-4 rounded-[26px] bg-[#1c1c1e] p-3">
      <Text className="mb-2 text-sm font-bold text-[#f5f5f7]">{label}</Text>
      <SegmentedControl options={options} selected={active} />
    </View>
  );
}

export function PrimaryAction({
  children,
  onPress,
}: {
  children: ReactNode;
  onPress(): void;
}) {
  return (
    <Button
      className="h-12 rounded-full bg-white outline-none"
      feedbackVariant="scale"
      onPress={onPress}
      variant="primary"
    >
      <Button.Label className="font-semibold text-black">{children}</Button.Label>
    </Button>
  );
}

export function WorkflowFooter({
  onNewIssue,
  onProject,
  onSearch,
}: {
  onNewIssue(): void;
  onProject(): void;
  onSearch(): void;
}) {
  return (
    <View className="mt-auto flex-row gap-2 px-4 pb-3 pt-3">
      <Pressable
        accessibilityRole="button"
        className="h-11 flex-1 flex-row items-center gap-2 rounded-full bg-[#1c1c1e] px-4"
        onPress={onProject}
      >
        <WorkflowIcon icon={GitFork} size={17} />
        <Text className="flex-1 text-xs font-semibold text-[#f5f5f7]">
          project-space
        </Text>
        <WorkflowIcon color={workflowColors.muted} icon={ChevronsUpDown} size={16} />
      </Pressable>
      <RoundIconButton
        accessibilityLabel="Search issues"
        icon={Search}
        onPress={onSearch}
      />
      <RoundIconButton
        accessibilityLabel="New issue"
        icon={SquarePen}
        onPress={onNewIssue}
      />
    </View>
  );
}
