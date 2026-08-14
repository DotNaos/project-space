import Bot from 'lucide-react-native/icons/bot';
import Globe2 from 'lucide-react-native/icons/earth';
import MessageCircle from 'lucide-react-native/icons/message-circle';
import UserRound from 'lucide-react-native/icons/user-round';
import { Pressable, Text, View } from 'react-native';

import type { WorkflowPage } from './mobile-workflow-data';
import {
  FlatGroup,
  FlatRow,
  ScreenScroll,
  SegmentedControl,
  WorkflowGate,
  WorkflowIcon,
  workflowColors,
} from './mobile-workflow-ui';

export type CodexPanel = 'browser' | 'chat';

function ChatPanel() {
  const messages = [
    {
      icon: Bot,
      muted: false,
      text: 'I audited the Doctor flow and the managed worktree for issue #300.',
    },
    {
      icon: UserRound,
      muted: true,
      text: 'Keep the readiness checks together and verify the repair path.',
    },
    {
      icon: Bot,
      muted: false,
      text: 'The focused checks pass. Four changed files remain to commit and push.',
    },
  ] as const;
  return (
    <FlatGroup>
      {messages.map((message) => (
        <FlatRow key={message.text}>
          <View className="h-8 w-8 items-center justify-center rounded-full bg-[#2c2c2e]">
            <WorkflowIcon
              color={workflowColors.muted}
              icon={message.icon}
              size={16}
            />
          </View>
          <Text
            className={`flex-1 text-sm leading-5 ${
              message.muted ? 'text-[#98989d]' : 'text-[#f5f5f7]'
            }`}
          >
            {message.text}
          </Text>
        </FlatRow>
      ))}
    </FlatGroup>
  );
}

function BrowserPanel({ onFeedback }: { onFeedback(message: string): void }) {
  return (
    <View className="mx-4 rounded-[24px] bg-[#1c1c1e] p-5">
      <View className="flex-row items-center gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-full bg-[#30d158]/15">
          <WorkflowIcon color={workflowColors.good} icon={Globe2} size={20} />
        </View>
        <View>
          <Text className="font-bold text-[#f5f5f7]">
            Tailscale Dev Server
          </Text>
          <Text className="mt-1 text-xs text-[#30d158]">
            Available on os-macbook
          </Text>
        </View>
      </View>
      <View className="mt-5 flex-row gap-3">
        <View className="flex-1 rounded-[20px] bg-[#2c2c2e] p-4">
          <Text className="text-xs text-[#98989d]">Project</Text>
          <Text className="mt-1 text-sm font-bold text-[#f5f5f7]">
            project-space
          </Text>
        </View>
        <View className="flex-1 rounded-[20px] bg-[#2c2c2e] p-4">
          <Text className="text-xs text-[#98989d]">Issue</Text>
          <Text className="mt-1 text-sm font-bold text-[#f5f5f7]">#300</Text>
        </View>
      </View>
      <Pressable
        className="mt-3 rounded-[20px] bg-[#2c2c2e] p-4"
        onPress={() =>
          onFeedback('Dev Server access is visual only in this prototype')
        }
      >
        <Text className="text-xs text-[#98989d]">Current work</Text>
        <Text className="mt-1 text-sm font-bold text-[#f5f5f7]">
          Project Doctor readiness flow
        </Text>
        <Text className="mt-2 text-xs leading-5 text-[#98989d]">
          Review the running surface while the Codex task remains active.
        </Text>
      </Pressable>
    </View>
  );
}

export function CodexScreen({
  panel,
  setPage,
  setPanel,
  showToast,
}: {
  panel: CodexPanel;
  setPage(page: WorkflowPage): void;
  setPanel(panel: CodexPanel): void;
  showToast(message: string): void;
}) {
  return (
    <View className="flex-1">
      <View className="h-10 flex-row items-center px-4">
        <View className="h-2 w-2 rounded-full bg-[#30d158]" />
        <Text className="ml-2 text-xs text-[#30d158]">Ready</Text>
        <Text className="mx-auto text-sm font-bold text-[#f5f5f7]">
          Codex: #300
        </Text>
      </View>
      <ScreenScroll>
        <View className="mx-4 mt-3">
          <SegmentedControl
            options={[
              {
                label: 'Chat',
                onPress: () => setPanel('chat'),
                value: 'chat',
              },
              {
                label: 'Browser',
                onPress: () => setPanel('browser'),
                value: 'browser',
              },
            ]}
            selected={panel}
          />
        </View>
        <View className="mt-3">
          {panel === 'chat' ? (
            <ChatPanel />
          ) : (
            <BrowserPanel onFeedback={showToast} />
          )}
        </View>
        <View className="mx-4 mt-3 h-12 flex-row items-center rounded-full bg-[#1c1c1e] px-4">
          <MessageCircle color={workflowColors.muted} size={16} />
          <Text className="ml-2 flex-1 text-sm text-[#98989d]">
            Send Message…
          </Text>
        </View>
        <View className="mt-3">
          <WorkflowGate
            active="not-completed"
            label="finished?"
            options={[
              {
                label: 'Not completed',
                onPress: () => showToast('Codex remains the active work loop'),
                value: 'not-completed',
              },
              {
                label: 'Completed',
                onPress: () => setPage('worktree'),
                value: 'completed',
              },
            ]}
          />
        </View>
      </ScreenScroll>
    </View>
  );
}
