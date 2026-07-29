import { Button } from 'heroui-native';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import Terminal from 'lucide-react-native/icons/square-terminal';
import X from 'lucide-react-native/icons/x';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  Text,
  View,
} from 'react-native';

import type { CodexModelRecord } from '../../../../src/shared/project-space-api';
import { NativeReviewComposer, type NativeReviewModelChoice } from './native-review-composer';
import { NativeReviewMarkdown } from './native-review-markdown';
import type { NativeCodexMessage, NativeCodexQueueItem } from './use-native-codex-session';
import type { NativeReviewImage } from './native-review-api';

export function NativeReviewChat({
  active,
  connecting,
  draft,
  error,
  images,
  messages,
  modelChoice,
  models,
  onAttach,
  onChangeDraft,
  onChooseModel,
  onClose,
  onQueue,
  onReload,
  onRemoveImage,
  onRemoveQueued,
  onSend,
  onSteer,
  queue,
  sending,
  subtitle,
  theme,
  title,
  visible,
}: {
  active: boolean;
  connecting: boolean;
  draft: string;
  error?: string;
  images: readonly NativeReviewImage[];
  messages: readonly NativeCodexMessage[];
  modelChoice: NativeReviewModelChoice;
  models: readonly CodexModelRecord[];
  onAttach(): void;
  onChangeDraft(value: string): void;
  onChooseModel(value: NativeReviewModelChoice): void;
  onClose(): void;
  onQueue(): void;
  onReload(): void;
  onRemoveImage(image: NativeReviewImage): void;
  onRemoveQueued(id: string): void;
  onSend(): void;
  onSteer(): void;
  queue: readonly NativeCodexQueueItem[];
  sending: boolean;
  subtitle: string;
  theme: 'dark' | 'light';
  title: string;
  visible: boolean;
}) {
  const dark = theme === 'dark';
  const scrollRef = useRef<ScrollView>(null);
  const [following, setFollowing] = useState(true);
  const textColor = dark ? '#e5e5e5' : '#27272a';
  const messageItems = messages.filter(
    (item) => item.kind === 'agent-message' || item.kind === 'user-message'
  );
  const activities = messages.filter(
    (item) => item.kind !== 'agent-message' && item.kind !== 'user-message'
  );
  const latestActivity = activities.at(-1);
  const scrollToBottom = (animated = true) => {
    setFollowing(true);
    requestAnimationFrame(() =>
      scrollRef.current?.scrollToEnd({ animated })
    );
  };
  useEffect(() => {
    if (visible) scrollToBottom(false);
  }, [visible]);
  useEffect(() => {
    if (visible && following) scrollToBottom(true);
  }, [
    following,
    messages.length,
    messages.at(-1)?.text,
    messages.at(-1)?.status,
    queue.length,
    visible,
  ]);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distance =
      contentSize.height - layoutMeasurement.height - contentOffset.y;
    setFollowing(distance < 56);
  };
  return (
    <Modal animationType="slide" onRequestClose={onClose} visible={visible}>
      <View
        className="flex-1"
        style={{ backgroundColor: dark ? '#090909' : '#fafafa' }}
      >
        <View className="flex-row items-center justify-between px-5 pb-4 pt-14">
          <View className="min-w-0 flex-1">
            <Text
              className="text-lg font-semibold"
              numberOfLines={1}
              style={{ color: dark ? '#fafafa' : '#18181b' }}
            >
              {title}
            </Text>
            <Text
              className="mt-1 text-xs"
              numberOfLines={1}
              style={{ color: dark ? '#737373' : '#71717a' }}
            >
              {subtitle}
            </Text>
          </View>
          <Button
            accessibilityLabel="Close conversation"
            isIconOnly
            onPress={onClose}
            variant="ghost"
          >
            <X color={dark ? '#fafafa' : '#18181b'} size={20} />
          </Button>
        </View>
        <ScrollView
          contentContainerStyle={{
            gap: 22,
            paddingBottom: 40,
            paddingHorizontal: 20,
            paddingTop: 16,
          }}
          onContentSizeChange={() => following && scrollToBottom(true)}
          onScroll={onScroll}
          ref={scrollRef}
          scrollEventThrottle={16}
        >
          {messageItems.map((item) => (
            <View
              className={
                item.kind === 'user-message'
                  ? 'max-w-[88%] self-end rounded-[22px] px-4 py-3'
                  : 'w-full'
              }
              key={item.id}
              style={
                item.kind === 'user-message'
                  ? { backgroundColor: dark ? '#262626' : '#e7e5e4' }
                  : undefined
              }
            >
              {item.images?.length ? (
                <View className="mb-3 flex-row flex-wrap gap-2">
                  {item.images.map((image) => (
                    <Image
                      key={image.id}
                      resizeMode="cover"
                      source={{ uri: image.dataUrl }}
                      style={{ borderRadius: 12, height: 150, width: 150 }}
                    />
                  ))}
                </View>
              ) : null}
              <NativeReviewMarkdown
                color={
                  item.kind === 'user-message'
                    ? dark
                      ? '#f5f5f5'
                      : '#18181b'
                    : textColor
                }
                text={item.text ?? ''}
              />
            </View>
          ))}
          {activities.length ? (
            active && latestActivity ? (
              <VisorActivity
                label={latestActivity.detail ?? latestActivity.text ?? latestActivity.kind}
                theme={theme}
              />
            ) : (
              <View className="flex-row items-center gap-2">
                <Terminal color={dark ? '#737373' : '#71717a'} size={16} />
                <Text
                  className="font-medium"
                  style={{ color: dark ? '#8b8b8b' : '#71717a' }}
                >
                  Worked with {activities.length}{' '}
                  {activities.length === 1 ? 'tool' : 'tools'}
                </Text>
              </View>
            )
          ) : null}
          {queue.map((item) => (
            <View
              className="flex-row items-center gap-2 rounded-full bg-neutral-800 px-4 py-2"
              key={item.id}
            >
              <Text className="min-w-0 flex-1 text-sm text-neutral-300" numberOfLines={1}>
                Queued · {item.message}
              </Text>
              <Button
                accessibilityLabel="Remove queued message"
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => onRemoveQueued(item.id)}
              >
                <X color="#a3a3a3" size={15} />
              </Button>
            </View>
          ))}
        </ScrollView>
        {!following ? (
          <View className="absolute bottom-40 self-center">
            <Button
              accessibilityLabel="Follow latest message"
              isIconOnly
              variant="secondary"
              onPress={() => scrollToBottom(true)}
            >
              <ChevronDown color={dark ? '#fafafa' : '#18181b'} size={20} />
            </Button>
          </View>
        ) : null}
        <View
          className="border-t px-4 pb-7 pt-3"
          style={{ borderColor: dark ? '#262626' : '#e4e4e7' }}
        >
          <NativeReviewComposer
            active={active}
            connecting={connecting}
            draft={draft}
            error={error}
            images={images}
            modelChoice={modelChoice}
            models={models}
            onAttach={onAttach}
            onChangeDraft={onChangeDraft}
            onChooseModel={onChooseModel}
            onQueue={onQueue}
            onRemoveImage={onRemoveImage}
            onRetry={onReload}
            onSend={onSend}
            onSteer={onSteer}
            sending={sending}
            theme={theme}
          />
        </View>
      </View>
    </Modal>
  );
}

function VisorActivity({
  label,
  theme,
}: {
  label: string;
  theme: 'dark' | 'light';
}) {
  const opacity = useRef(new Animated.Value(0.48)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          duration: 1200,
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          duration: 1200,
          toValue: 0.48,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);
  return (
    <View className="flex-row items-center gap-2">
      <Terminal color={theme === 'dark' ? '#737373' : '#71717a'} size={16} />
      <Animated.Text
        className="font-semibold"
        numberOfLines={1}
        style={{
          color: theme === 'dark' ? '#a3a3a3' : '#52525b',
          opacity,
        }}
      >
        {label}
      </Animated.Text>
    </View>
  );
}
