import ArrowUpRight from 'lucide-react-native/icons/arrow-up-right';
import ListChecks from 'lucide-react-native/icons/list-checks';
import MapIcon from 'lucide-react-native/icons/map';
import Maximize2 from 'lucide-react-native/icons/maximize-2';
import Send from 'lucide-react-native/icons/send';
import { Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import {
  workflowIssues,
  type WorkflowIssue,
  type WorkflowPage,
} from './mobile-workflow-data';
import {
  BackRow,
  FlatGroup,
  FlatRow,
  PrimaryAction,
  ScreenScroll,
  SectionTitle,
  SegmentedControl,
  WorkflowIcon,
  workflowColors,
} from './mobile-workflow-ui';

function IssueStatus({ status }: Pick<WorkflowIssue, 'status'>) {
  return status === 'active' ? (
    <View className="h-2 w-2 rounded-full bg-white" />
  ) : (
    <View className="h-2.5 w-2.5 rounded-full border border-[#98989d]" />
  );
}

function ViewPicker({
  page,
  setPage,
}: {
  page: 'issue-list' | 'issue-map';
  setPage(page: WorkflowPage): void;
}) {
  return (
    <SegmentedControl
      options={[
        { label: 'List', onPress: () => setPage('issue-list'), value: 'issue-list' },
        { label: 'Map', onPress: () => setPage('issue-map'), value: 'issue-map' },
      ]}
      selected={page}
    />
  );
}

export function IssueListScreen({
  onIssue,
  setPage,
}: {
  onIssue(issue: WorkflowIssue): void;
  setPage(page: WorkflowPage): void;
}) {
  return (
    <ScreenScroll>
      <SectionTitle
        action={<ViewPicker page="issue-list" setPage={setPage} />}
        icon={ListChecks}
        title="Issues"
      />
      <FlatGroup>
        {workflowIssues.map((issue) => (
          <FlatRow
            key={issue.number}
            onPress={() =>
              issue.number === 300 ? setPage('issue-detail') : onIssue(issue)
            }
          >
            <Text className="text-sm font-bold text-[#f5f5f7]">
              #{issue.number}
            </Text>
            <Text
              className="min-w-0 flex-1 text-sm text-[#f5f5f7]"
              numberOfLines={1}
            >
              {issue.title}
            </Text>
            <IssueStatus status={issue.status} />
          </FlatRow>
        ))}
      </FlatGroup>
    </ScreenScroll>
  );
}

function MapNode({
  issue,
  label,
  onPress,
  style,
}: {
  issue: number;
  label: string;
  onPress(): void;
  style: object;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className="absolute w-24 rounded-[22px] bg-[#1c1c1e] p-3"
      onPress={onPress}
      style={style}
    >
      <Text className="text-sm font-bold text-[#f5f5f7]">#{issue}</Text>
      <Text className="mt-2 text-[10px] text-[#98989d]" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function IssueMapScreen({
  onIssue,
  setPage,
}: {
  onIssue(issue: WorkflowIssue): void;
  setPage(page: WorkflowPage): void;
}) {
  const issue = (number: number) =>
    workflowIssues.find((candidate) => candidate.number === number)!;
  return (
    <View className="flex-1">
      <SectionTitle
        action={<ViewPicker page="issue-map" setPage={setPage} />}
        icon={MapIcon}
        title="Issues"
      />
      <View className="relative mx-4 flex-1">
        <Svg
          height="100%"
          style={{ pointerEvents: 'none' }}
          viewBox="0 0 350 555"
          width="100%"
        >
          <Path
            d="M175 310V255C175 238 161 225 144 225H118V210 M175 255C175 238 189 225 206 225H232V210 M118 160V106 M111 114l7-8 7 8 M225 218l7-8 7 8 M111 218l7-8 7 8"
            fill="none"
            stroke={workflowColors.muted}
            strokeWidth={1.5}
          />
        </Svg>
        <MapNode
          issue={340}
          label="App Server"
          onPress={() => onIssue(issue(340))}
          style={{ left: '20%', top: 32 }}
        />
        <MapNode
          issue={300}
          label="Readiness"
          onPress={() => setPage('issue-detail')}
          style={{ left: '20%', top: 160 }}
        />
        <MapNode
          issue={269}
          label="Codex UI"
          onPress={() => onIssue(issue(269))}
          style={{ right: '14%', top: 160 }}
        />
        <MapNode
          issue={298}
          label="Changelog"
          onPress={() => onIssue(issue(298))}
          style={{ left: '36%', top: 310 }}
        />
        <View className="absolute bottom-7 left-[11%] right-[11%] flex-row gap-4 rounded-[28px] bg-[#1c1c1e]/70 p-3">
          <Pressable
            className="flex-1 rounded-[22px] bg-[#2c2c2e] p-3"
            onPress={() => onIssue(issue(305))}
          >
            <Text className="text-sm font-bold text-[#f5f5f7]">#305</Text>
            <Text className="mt-2 text-[10px] text-[#98989d]">Mobile</Text>
          </Pressable>
          <Pressable
            className="flex-1 rounded-[22px] bg-[#2c2c2e] p-3"
            onPress={() => onIssue(issue(193))}
          >
            <Text className="text-sm font-bold text-[#f5f5f7]">#193</Text>
            <Text className="mt-2 text-[10px] text-[#98989d]">Resources</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export function IssueDetailScreen({
  setPage,
}: {
  setPage(page: WorkflowPage): void;
}) {
  return (
    <View className="flex-1">
      <BackRow label="Issues" onPress={() => setPage('issue-list')} />
      <ScreenScroll>
        <View className="px-5 pt-5">
          <View className="flex-row items-start gap-4">
            <Text className="flex-1 text-2xl font-extrabold tracking-[-0.7px] text-[#f5f5f7]">
              #300 · Centralize machine readiness
            </Text>
            <Pressable
              accessibilityLabel="Continue issue in Codex"
              className="h-11 w-11 items-center justify-center rounded-full bg-white/15"
              onPress={() => setPage('codex')}
            >
              <WorkflowIcon icon={ArrowUpRight} size={24} />
            </Pressable>
          </View>
          <Text className="mt-6 text-base font-bold text-[#f5f5f7]">
            Project Doctor
          </Text>
          <Text className="mt-2 text-base font-bold text-[#98989d]">
            Readiness checks and repair flow
          </Text>
        </View>
        <View className="mx-5 mt-8 border-t border-[#38383a] pt-6">
          <Text className="text-lg font-bold text-[#f5f5f7]">chat</Text>
          <View className="mt-3 self-start">
            <SegmentedControl
              options={[
                { label: '1', onPress: () => undefined, value: '1' },
                { label: '2', onPress: () => undefined, value: '2' },
              ]}
              selected="1"
            />
          </View>
        </View>
        <View className="relative mx-5 mt-4 min-h-56 rounded-[24px] bg-[#1c1c1e] p-5">
          <View className="absolute right-4 top-4">
            <WorkflowIcon
              color={workflowColors.muted}
              icon={Maximize2}
              size={16}
            />
          </View>
          <Text className="pt-4 text-sm font-bold text-[#f5f5f7]">Goal</Text>
          <Text className="mt-2 text-sm leading-6 text-[#98989d]">
            Keep Codex, Git, and managed worktree readiness visible in one
            Doctor flow.
          </Text>
          <View className="mt-4 flex-row items-center gap-2">
            <View className="h-2 w-2 rounded-full bg-[#30d158]" />
            <Text className="text-sm text-[#30d158]">
              Worktree prepared on os-macbook
            </Text>
          </View>
        </View>
        <View className="mx-5 mt-3 h-12 flex-row items-center rounded-full bg-[#1c1c1e] px-4">
          <Text className="flex-1 text-sm text-[#98989d]">Send Message…</Text>
          <View className="h-8 w-8 items-center justify-center rounded-full bg-white">
            <WorkflowIcon color="black" icon={Send} size={15} />
          </View>
        </View>
        <View className="mx-5 mt-3">
          <PrimaryAction onPress={() => setPage('codex')}>
            Open in Codex
          </PrimaryAction>
        </View>
      </ScreenScroll>
    </View>
  );
}
