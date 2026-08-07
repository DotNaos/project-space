import Check from 'lucide-react-native/icons/check';
import ImageIcon from 'lucide-react-native/icons/image';
import Paperclip from 'lucide-react-native/icons/paperclip';
import Search from 'lucide-react-native/icons/search';
import X from 'lucide-react-native/icons/x';
import { useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import {
  workflowIssues,
  workflowPageLabels,
  type WorkflowIssue,
  type WorkflowPage,
} from './mobile-workflow-data';
import {
  PrimaryAction,
  RoundIconButton,
  WorkflowIcon,
  workflowColors,
} from './mobile-workflow-ui';

export type WorkflowOverlay =
  | { kind: 'info' }
  | { issue: WorkflowIssue; kind: 'issue' }
  | { kind: 'new-issue' }
  | { kind: 'project' }
  | { kind: 'search' };

function SheetHeader({
  onClose,
  title,
}: {
  onClose(): void;
  title: string;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <Text className="flex-1 text-xl font-bold text-[#f5f5f7]">{title}</Text>
      <RoundIconButton
        accessibilityLabel="Close"
        icon={X}
        onPress={onClose}
      />
    </View>
  );
}

function ProjectSheet({ onClose }: { onClose(): void }) {
  return (
    <>
      <SheetHeader onClose={onClose} title="Select project" />
      <Pressable
        className="mt-5 flex-row items-center rounded-[22px] bg-[#1c1c1e] px-4 py-4"
        onPress={onClose}
      >
        <View className="h-10 w-10 items-center justify-center rounded-[14px] bg-white">
          <Text className="font-extrabold text-black">PS</Text>
        </View>
        <View className="ml-3 flex-1">
          <Text className="font-bold text-[#f5f5f7]">project-space</Text>
          <Text className="mt-1 text-xs text-[#98989d]">Selected project</Text>
        </View>
        <WorkflowIcon icon={Check} size={19} />
      </Pressable>
    </>
  );
}

function SearchSheet({
  onClose,
  onIssue,
}: {
  onClose(): void;
  onIssue(issue: WorkflowIssue): void;
}) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const value = query.trim().toLowerCase();
    return workflowIssues.filter((issue) =>
      `#${issue.number} ${issue.title}`.toLowerCase().includes(value)
    );
  }, [query]);
  return (
    <>
      <SheetHeader onClose={onClose} title="Search issues" />
      <View className="mt-4 h-12 flex-row items-center gap-3 rounded-full bg-[#1c1c1e] px-4">
        <WorkflowIcon color={workflowColors.muted} icon={Search} size={17} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          className="h-full flex-1 text-sm text-[#f5f5f7]"
          onChangeText={setQuery}
          placeholder="Number or title"
          placeholderTextColor={workflowColors.muted}
          value={query}
        />
      </View>
      <Text className="mt-3 text-xs text-[#98989d]">
        {matches.length} {matches.length === 1 ? 'issue' : 'issues'}
      </Text>
      <View className="mt-2 max-h-72 overflow-hidden rounded-[22px] bg-[#1c1c1e]">
        {matches.slice(0, 5).map((issue) => (
          <Pressable
            className="flex-row items-center gap-3 border-b border-[#38383a]/60 px-4 py-3 last:border-b-0"
            key={issue.number}
            onPress={() => onIssue(issue)}
          >
            <Text className="text-sm font-bold text-[#f5f5f7]">
              #{issue.number}
            </Text>
            <Text className="flex-1 text-sm text-[#f5f5f7]" numberOfLines={1}>
              {issue.title}
            </Text>
          </Pressable>
        ))}
      </View>
    </>
  );
}

const labels = [
  { color: '#ffb340', label: 'readiness' },
  { color: '#66d98b', label: 'docs' },
  { color: '#64d2ff', label: 'mobile' },
] as const;

function NewIssueSheet({
  onClose,
  showToast,
}: {
  onClose(): void;
  showToast(message: string): void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [attachment, setAttachment] = useState(false);
  const submit = () => {
    if (!title.trim()) {
      showToast('Add a title before creating the issue');
      return;
    }
    onClose();
    showToast(`Draft “${title.trim()}” created locally`);
  };
  return (
    <>
      <SheetHeader onClose={onClose} title="New issue" />
      <TextInput
        className="mt-3 border-b border-[#38383a]/60 py-3 text-base font-semibold text-[#f5f5f7]"
        onChangeText={setTitle}
        placeholder="Title"
        placeholderTextColor={workflowColors.muted}
        value={title}
      />
      <TextInput
        className="min-h-20 border-b border-[#38383a]/60 py-3 text-sm text-[#f5f5f7]"
        multiline
        onChangeText={setDescription}
        placeholder="Description"
        placeholderTextColor={workflowColors.muted}
        textAlignVertical="top"
        value={description}
      />
      <View className="mt-3 flex-row flex-wrap gap-2">
        {labels.map((item) => {
          const active = selected.includes(item.label);
          return (
            <Pressable
              className="rounded-full px-3 py-2"
              key={item.label}
              onPress={() =>
                setSelected((current) =>
                  active
                    ? current.filter((label) => label !== item.label)
                    : [...current, item.label]
                )
              }
              style={{
                backgroundColor: `${item.color}22`,
                borderColor: active ? item.color : 'transparent',
                borderWidth: 1,
              }}
            >
              <Text className="text-xs font-medium" style={{ color: item.color }}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View className="mt-3 min-h-10 flex-row items-center">
        {attachment ? (
          <>
            <WorkflowIcon color={workflowColors.muted} icon={ImageIcon} size={19} />
            <Text className="ml-3 flex-1 text-sm text-[#98989d]">
              image-attachment.png
            </Text>
            <RoundIconButton
              accessibilityLabel="Remove attachment"
              icon={X}
              onPress={() => setAttachment(false)}
            />
          </>
        ) : (
          <RoundIconButton
            accessibilityLabel="Attach image"
            icon={Paperclip}
            onPress={() => setAttachment(true)}
          />
        )}
      </View>
      <View className="mt-3">
        <PrimaryAction onPress={submit}>Create issue</PrimaryAction>
      </View>
    </>
  );
}

function InfoSheet({ onClose, page }: { onClose(): void; page: WorkflowPage }) {
  return (
    <>
      <SheetHeader onClose={onClose} title={workflowPageLabels[page]} />
      <Text className="mt-2 text-sm text-[#98989d]">
        Current view in the accepted mobile workflow.
      </Text>
      <View className="mt-4 flex-row flex-wrap gap-2">
        {['project-space', 'Issue #300', 'PR #333', 'os-macbook'].map((value) => (
          <View
            className="rounded-full bg-[#1c1c1e] px-4 py-3"
            key={value}
          >
            <Text className="text-xs font-semibold text-[#f5f5f7]">{value}</Text>
          </View>
        ))}
      </View>
    </>
  );
}

function IssueSheet({
  issue,
  onClose,
}: {
  issue: WorkflowIssue;
  onClose(): void;
}) {
  return (
    <>
      <SheetHeader onClose={onClose} title={`#${issue.number}`} />
      <Text className="mt-2 text-lg font-bold text-[#f5f5f7]">
        {issue.title}
      </Text>
      <Text className="mt-3 text-sm text-[#98989d]">
        Open from the Issue Board list or map.
      </Text>
    </>
  );
}

export function WorkflowOverlaySheet({
  onClose,
  onIssue,
  overlay,
  page,
  showToast,
}: {
  onClose(): void;
  onIssue(issue: WorkflowIssue): void;
  overlay: WorkflowOverlay;
  page: WorkflowPage;
  showToast(message: string): void;
}) {
  return (
    <View className="absolute inset-0 z-50 justify-end p-3">
      <Pressable
        accessibilityLabel="Close details"
        className="absolute inset-0 bg-black/70"
        onPress={onClose}
      />
      <View className="rounded-[30px] bg-[#2c2c2e] p-5">
        <View className="mx-auto mb-5 h-1 w-10 rounded-full bg-[#98989d]/50" />
        {overlay.kind === 'project' ? <ProjectSheet onClose={onClose} /> : null}
        {overlay.kind === 'search' ? (
          <SearchSheet onClose={onClose} onIssue={onIssue} />
        ) : null}
        {overlay.kind === 'new-issue' ? (
          <NewIssueSheet onClose={onClose} showToast={showToast} />
        ) : null}
        {overlay.kind === 'info' ? (
          <InfoSheet onClose={onClose} page={page} />
        ) : null}
        {overlay.kind === 'issue' ? (
          <IssueSheet issue={overlay.issue} onClose={onClose} />
        ) : null}
      </View>
    </View>
  );
}
