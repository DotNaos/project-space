import ArrowRight from 'lucide-react-native/icons/arrow-right';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import FileCheck from 'lucide-react-native/icons/file-check';
import FileCode from 'lucide-react-native/icons/file-code';
import FileText from 'lucide-react-native/icons/file-text';
import GitBranch from 'lucide-react-native/icons/git-branch';
import GitPullRequest from 'lucide-react-native/icons/git-pull-request';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import ScanEye from 'lucide-react-native/icons/scan-eye';
import { Pressable, Text, View } from 'react-native';

import type { WorkflowPage } from './mobile-workflow-data';
import {
  BackRow,
  FlatGroup,
  FlatRow,
  PrimaryAction,
  ScreenScroll,
  WorkflowGate,
  WorkflowIcon,
  workflowColors,
} from './mobile-workflow-ui';

const changes = [
  { detail: '18 additions · 4 deletions', icon: FileCode, name: 'doctor.go' },
  { detail: '42 additions', icon: FileCode, name: 'readiness.go' },
  { detail: '6 checks updated', icon: FileCheck, name: 'readiness_test.go' },
  { detail: 'Repair flow documented', icon: FileText, name: 'project-doctor.md' },
] as const;

export function WorktreeScreen({
  setPage,
  showToast,
}: {
  setPage(page: WorkflowPage): void;
  showToast(message: string): void;
}) {
  return (
    <View className="flex-1">
      <BackRow label="Workspaces" onPress={() => setPage('codex')} />
      <ScreenScroll>
        <View className="px-5 pb-4 pt-2">
          <Text className="text-lg font-bold text-[#f5f5f7]">issue-300</Text>
          <Text className="mt-1 text-xs text-[#98989d]">
            Centralize machine readiness
          </Text>
        </View>
        <WorkflowGate
          active="yes"
          label="dirty?"
          options={[
            {
              label: 'yes',
              onPress: () => showToast('Worktree remains active while dirty'),
              value: 'yes',
            },
            {
              label: 'no',
              onPress: () => setPage('branch'),
              value: 'no',
            },
          ]}
        />
        <View className="mt-3">
          <FlatGroup>
            <View className="border-b border-[#38383a] px-4 py-3">
              <Text className="text-sm font-semibold text-[#f5f5f7]">
                Changes
              </Text>
            </View>
            {changes.map((change) => (
              <FlatRow key={change.name}>
                <WorkflowIcon
                  color={workflowColors.muted}
                  icon={change.icon}
                  size={22}
                />
                <View className="min-w-0 flex-1">
                  <Text
                    className="text-sm font-bold text-[#f5f5f7]"
                    numberOfLines={1}
                  >
                    {change.name}
                  </Text>
                  <Text className="mt-1 text-xs text-[#98989d]">
                    {change.detail}
                  </Text>
                </View>
                <Text className="text-xs text-[#30d158]">M</Text>
              </FlatRow>
            ))}
          </FlatGroup>
        </View>
        <View className="mx-4 mt-4">
          <PrimaryAction
            onPress={() =>
              showToast('Prototype only — no Git command was performed')
            }
          >
            commit / push
          </PrimaryAction>
        </View>
        <Pressable
          className="mx-4 mt-3 h-12 flex-row items-center rounded-full bg-[#1c1c1e] px-4"
          onPress={() => setPage('branch')}
        >
          <Text className="flex-1 text-sm font-semibold text-white">
            Not dirty → branch work
          </Text>
          <WorkflowIcon icon={ArrowRight} size={18} />
        </Pressable>
      </ScreenScroll>
    </View>
  );
}

export function BranchScreen({
  setPage,
  showToast,
}: {
  setPage(page: WorkflowPage): void;
  showToast(message: string): void;
}) {
  return (
    <ScreenScroll>
      <View className="mx-4 mt-5 rounded-[28px] bg-[#1c1c1e] p-4">
        <Text className="text-sm text-[#98989d]">branch work</Text>
        <Text className="mt-3 text-xl font-extrabold text-[#f5f5f7]">
          300-centralize-machine-readiness
        </Text>
        <View className="relative mt-5 h-36 rounded-[24px] bg-[#2c2c2e]">
          <View className="absolute left-5 right-5 top-14 h-px bg-[#98989d]" />
          <View className="absolute left-5 top-[49px] h-3 w-3 rounded-full border-2 border-[#98989d] bg-[#2c2c2e]" />
          <View className="absolute right-5 top-[47px] h-4 w-4 rounded-full border-2 border-white bg-[#2c2c2e]" />
          <Text className="absolute left-5 top-20 text-xs text-[#f5f5f7]">
            main
          </Text>
          <Text
            className="absolute right-4 top-20 max-w-52 rounded-full bg-white/10 px-2 py-1 text-[10px] text-white"
            numberOfLines={1}
          >
            300-centralize-machine-readiness
          </Text>
        </View>
        <View className="-mx-4 mt-5">
          <WorkflowGate
            active="yes"
            label="behind main?"
            options={[
              {
                label: 'yes',
                onPress: () => showToast('Branch work remains active while behind main'),
                value: 'yes',
              },
              {
                label: 'no',
                onPress: () => setPage('pull-request'),
                value: 'no',
              },
            ]}
          />
        </View>
        <Pressable
          className="mt-4 min-h-14 flex-row items-center gap-3 rounded-full bg-[#2c2c2e] px-4"
          onPress={() => showToast('Rebase remains inside the branch work loop')}
        >
          <View className="h-9 w-9 items-center justify-center rounded-full bg-white/10">
            <WorkflowIcon icon={RefreshCw} size={18} />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-bold text-[#f5f5f7]">Behind main</Text>
            <Text className="mt-1 text-xs text-[#98989d]">
              Continue branch work
            </Text>
          </View>
        </Pressable>
        <Pressable
          className="mt-3 min-h-14 flex-row items-center gap-3 rounded-full bg-[#2c2c2e] px-4"
          onPress={() => setPage('pull-request')}
        >
          <View className="h-9 w-9 items-center justify-center rounded-full bg-white/10">
            <WorkflowIcon icon={ArrowRight} size={18} />
          </View>
          <Text className="flex-1 text-sm font-bold text-[#f5f5f7]">
            Not behind main{' '}
            <Text className="text-[#98989d]">→ pull request</Text>
          </Text>
        </Pressable>
      </View>
    </ScreenScroll>
  );
}

const checks = [
  { detail: 'Passed', icon: CircleCheck, label: 'Doctor checks' },
  { detail: 'Passed', icon: CircleCheck, label: 'Go tests' },
  { detail: 'Passed', icon: CircleCheck, label: 'Docs checks' },
  { detail: 'Ready', icon: ScanEye, label: 'Preview review' },
] as const;

export function PullRequestScreen({
  setPage,
}: {
  setPage(page: WorkflowPage): void;
}) {
  return (
    <ScreenScroll>
      <View className="flex-row items-center gap-2 px-4 py-4">
        <WorkflowIcon
          color={workflowColors.muted}
          icon={GitPullRequest}
          size={16}
        />
        <Text className="text-sm text-[#98989d]">Workspaces</Text>
      </View>
      <View className="mx-4">
        <Text className="text-xl font-extrabold text-[#f5f5f7]">
          Centralize machine readiness
        </Text>
        <View className="mt-4 rounded-[24px] bg-[#1c1c1e] p-4">
          <Text className="text-3xl font-extrabold text-[#f5f5f7]">
            PR #333
          </Text>
          <View className="mt-4 flex-row items-center gap-3 rounded-full bg-[#2c2c2e] p-3">
            <WorkflowIcon icon={GitBranch} size={18} />
            <Text
              className="min-w-0 flex-1 text-xs text-[#f5f5f7]"
              numberOfLines={1}
            >
              300-centralize-machine-readiness
            </Text>
            <WorkflowIcon
              color={workflowColors.muted}
              icon={ArrowRight}
              size={15}
            />
            <Text className="text-xs text-[#f5f5f7]">main</Text>
          </View>
        </View>
      </View>
      <View className="mt-4">
        <FlatGroup>
          {checks.map((check) => (
            <FlatRow key={check.label}>
              <View className="h-10 w-10 items-center justify-center rounded-full bg-[#2c2c2e]">
                <WorkflowIcon
                  color={
                    check.label === 'Preview review'
                      ? workflowColors.white
                      : workflowColors.good
                  }
                  icon={check.icon}
                  size={19}
                />
              </View>
              <View className="flex-1">
                <Text className="text-sm font-bold text-[#f5f5f7]">
                  {check.label}
                </Text>
                <Text className="mt-1 text-xs text-[#98989d]">
                  {check.detail}
                </Text>
              </View>
            </FlatRow>
          ))}
        </FlatGroup>
      </View>
      <Pressable
        className="mx-4 mt-3 h-12 flex-row items-center gap-3 rounded-full bg-[#1c1c1e] px-4"
        onPress={() => setPage('docs')}
      >
        <WorkflowIcon icon={FileText} size={18} />
        <Text className="flex-1 text-sm text-[#f5f5f7]">
          changelog, docs & screenshots
        </Text>
        <WorkflowIcon icon={ArrowRight} size={18} />
      </Pressable>
      <View className="mx-4 mt-3">
        <PrimaryAction onPress={() => setPage('docs')}>
          Continue to /docs
        </PrimaryAction>
      </View>
    </ScreenScroll>
  );
}
