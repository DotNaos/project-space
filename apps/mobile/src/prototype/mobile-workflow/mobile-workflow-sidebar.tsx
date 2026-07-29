import CircleDot from 'lucide-react-native/icons/circle-dot';
import FileText from 'lucide-react-native/icons/file-text';
import Files from 'lucide-react-native/icons/files';
import GitBranch from 'lucide-react-native/icons/git-branch';
import GitFork from 'lucide-react-native/icons/git-fork';
import GitPullRequest from 'lucide-react-native/icons/git-pull-request';
import ListChecks from 'lucide-react-native/icons/list-checks';
import MessageSquare from 'lucide-react-native/icons/message-square';
import PanelLeftClose from 'lucide-react-native/icons/panel-left-close';
import ScanEye from 'lucide-react-native/icons/scan-eye';
import type { LucideIcon } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import {
  workflowNavItems,
  type WorkflowPage,
} from './mobile-workflow-data';
import {
  RoundIconButton,
  WorkflowIcon,
  workflowColors,
} from './mobile-workflow-ui';

const icons: Record<WorkflowPage, LucideIcon> = {
  branch: GitBranch,
  codex: MessageSquare,
  docs: FileText,
  'issue-detail': CircleDot,
  'issue-list': ListChecks,
  'issue-map': GitFork,
  preview: ScanEye,
  'pull-request': GitPullRequest,
  worktree: Files,
};

export function WorkflowSidebar({
  onClose,
  onProject,
  page,
  setPage,
}: {
  onClose(): void;
  onProject(): void;
  page: WorkflowPage;
  setPage(page: WorkflowPage): void;
}) {
  const choose = (next: WorkflowPage) => {
    setPage(next);
    onClose();
  };
  return (
    <View className="h-full bg-[#1c1c1e] px-3 pb-4 pt-3">
      <View className="relative h-12 flex-row items-center gap-3 px-1 pr-12">
        <View className="h-8 w-8 items-center justify-center rounded-[11px] bg-white">
          <Text className="text-sm font-extrabold text-black">PS</Text>
        </View>
        <Text className="flex-1 text-sm font-bold text-[#f5f5f7]">
          Project Space
        </Text>
        <View className="absolute right-0 top-1">
          <RoundIconButton
            accessibilityLabel="Close sidebar"
            icon={PanelLeftClose}
            onPress={onClose}
          />
        </View>
      </View>
      <Text className="mb-2 mt-6 px-4 text-xs font-medium text-[#98989d]">
        Current issue
      </Text>
      <Pressable
        className="flex-row items-center gap-3 rounded-full px-4 py-3"
        onPress={() => choose('issue-detail')}
      >
        <WorkflowIcon icon={CircleDot} size={17} />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-bold text-[#f5f5f7]" numberOfLines={1}>
            #300 · Machine readiness
          </Text>
          <Text className="mt-1 text-xs text-[#98989d]">In progress</Text>
        </View>
      </Pressable>
      <Text className="mb-2 mt-6 px-4 text-xs font-medium text-[#98989d]">
        Workflow
      </Text>
      {workflowNavItems.map((item) => {
        const active = item.page === page;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            className={`flex-row items-center gap-3 rounded-full px-4 py-2.5 ${
              active ? 'bg-[#2c2c2e]' : ''
            }`}
            key={item.page}
            onPress={() => choose(item.page)}
          >
            <WorkflowIcon
              color={active ? workflowColors.white : workflowColors.text}
              icon={icons[item.page]}
              size={17}
            />
            <Text className="text-sm font-medium text-[#e5e5e7]">
              {item.label}
            </Text>
          </Pressable>
        );
      })}
      <Pressable
        accessibilityRole="button"
        className="mt-auto h-12 flex-row items-center gap-3 rounded-full px-3"
        onPress={onProject}
      >
        <View className="h-8 w-8 items-center justify-center rounded-[11px] bg-white">
          <Text className="text-xs font-extrabold text-black">PS</Text>
        </View>
        <Text className="flex-1 text-sm font-bold text-[#f5f5f7]">
          project-space
        </Text>
        <WorkflowIcon color={workflowColors.muted} icon={GitFork} size={17} />
      </Pressable>
    </View>
  );
}
