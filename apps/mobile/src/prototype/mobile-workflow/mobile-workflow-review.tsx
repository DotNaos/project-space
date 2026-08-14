import CircleCheck from 'lucide-react-native/icons/circle-check';
import ImageIcon from 'lucide-react-native/icons/image';
import { Pressable, Text, View } from 'react-native';

import type { WorkflowPage } from './mobile-workflow-data';
import {
  PrimaryAction,
  ScreenScroll,
  WorkflowIcon,
  workflowColors,
} from './mobile-workflow-ui';

export function DocsScreen({
  setPage,
  showToast,
}: {
  setPage(page: WorkflowPage): void;
  showToast(message: string): void;
}) {
  return (
    <ScreenScroll>
      <View className="px-5 pt-5">
        <Text className="text-center text-4xl font-extrabold tracking-[-1px] text-[#f5f5f7]">
          /docs
        </Text>
        <Text className="mt-1 text-center text-sm text-[#98989d]">
          PR #333 · Project Doctor
        </Text>
      </View>
      <View className="px-5 pt-6">
        <Text className="text-lg font-bold text-[#f5f5f7]">
          changelog / docs
        </Text>
        <View className="mt-3 min-h-52 rounded-[24px] bg-[#1c1c1e] p-5">
          <Text className="text-sm font-bold text-[#f5f5f7]">
            Centralized machine readiness
          </Text>
          <Text className="mt-3 text-sm leading-6 text-[#98989d]">
            Project Doctor now presents Codex, Git, and managed-worktree
            readiness in one repair flow.
          </Text>
          <View className="mt-4 flex-row items-center gap-2">
            <WorkflowIcon
              color={workflowColors.good}
              icon={CircleCheck}
              size={16}
            />
            <Text className="text-sm text-[#30d158]">Checks documented</Text>
          </View>
        </View>
      </View>
      <View className="px-5 pt-5">
        <Text className="text-lg font-bold text-[#f5f5f7]">screenshots</Text>
        <View className="mt-3 flex-row gap-3">
          {['doctor-status.png', 'repair-flow.png'].map((name) => (
            <Pressable
              accessibilityRole="button"
              className="h-28 flex-1 items-center justify-center rounded-[24px] bg-[#1c1c1e]"
              key={name}
              onPress={() => showToast(`${name} · attached to PR #333`)}
            >
              <WorkflowIcon
                color={workflowColors.muted}
                icon={ImageIcon}
                size={27}
              />
              <Text className="mt-2 text-[10px] text-[#98989d]">{name}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View className="mx-5 mt-5">
        <PrimaryAction onPress={() => setPage('preview')}>
          Deploy preview
        </PrimaryAction>
      </View>
    </ScreenScroll>
  );
}

export function PreviewScreen({
  setPage,
  showToast,
}: {
  setPage(page: WorkflowPage): void;
  showToast(message: string): void;
}) {
  return (
    <ScreenScroll>
      <View className="mx-4 mt-4 rounded-[24px] bg-[#1c1c1e] p-4">
        <View className="flex-row items-center gap-3 border-b border-[#38383a] pb-4">
          <View className="h-2.5 w-2.5 rounded-full bg-[#30d158]" />
          <Text className="flex-1 text-base font-bold text-[#f5f5f7]">
            pr-333.projects.os-home.net
          </Text>
          <Text className="rounded-full bg-[#30d158]/10 px-2.5 py-1 text-[10px] text-[#30d158]">
            LIVE
          </Text>
        </View>
        <Text className="mt-4 text-xl font-extrabold text-[#f5f5f7]">
          PR #333 · Project Doctor
        </Text>
        <View className="mt-4 h-72 overflow-hidden rounded-[24px] bg-[#000000]">
          <View className="h-10 flex-row items-center gap-2 border-b border-[#38383a] px-3">
            <View className="h-2 w-2 rounded-full bg-[#414545]" />
            <View className="h-2 w-2 rounded-full bg-[#414545]" />
            <Text className="ml-2 text-[10px] text-[#98989d]">
              Machine readiness
            </Text>
          </View>
          <View className="p-5">
            <View className="rounded-[20px] bg-[#2c2c2e] p-4">
              <View className="flex-row items-center gap-2">
                <View className="h-2 w-2 rounded-full bg-[#30d158]" />
                <Text className="text-sm font-bold text-[#f5f5f7]">
                  os-macbook is ready
                </Text>
              </View>
              <Text className="mt-2 text-xs text-[#98989d]">
                Codex · Git · Worktree
              </Text>
            </View>
            <View className="mt-4 flex-row gap-3">
              {['Codex', 'Git', 'Worktree'].map((label) => (
                <View
                  className="h-16 flex-1 items-center justify-center rounded-[18px] bg-[#2c2c2e]"
                  key={label}
                >
                  <Text className="text-xs text-[#f5f5f7]">{label}</Text>
                </View>
              ))}
            </View>
            <View className="mt-4 h-14 flex-row items-center justify-between rounded-[18px] bg-[#2c2c2e] px-4">
              <Text className="text-xs text-[#f5f5f7]">Repair flow</Text>
              <Text className="text-xs text-[#30d158]">Verified</Text>
            </View>
          </View>
        </View>
        <Text className="mt-5 text-lg font-bold text-[#f5f5f7]">
          acceptable?
        </Text>
        <Pressable
          className="mt-3 h-12 items-center justify-center rounded-full bg-[#ff453a]/15"
          onPress={() => setPage('codex')}
        >
          <Text className="text-sm font-semibold text-[#ff453a]">
            Return to Codex
          </Text>
        </Pressable>
        <View className="mt-3">
          <PrimaryAction
            onPress={() =>
              showToast('Prototype only — no merge was performed')
            }
          >
            Merge to main
          </PrimaryAction>
        </View>
        <Text className="mt-4 border-t border-[#38383a] pt-4 text-center text-sm text-[#98989d]">
          main → deploy to production
        </Text>
      </View>
    </ScreenScroll>
  );
}
