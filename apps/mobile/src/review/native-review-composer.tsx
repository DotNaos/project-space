import { Button, Spinner } from 'heroui-native';
import ArrowUp from 'lucide-react-native/icons/arrow-up';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ImagePlus from 'lucide-react-native/icons/image-plus';
import ListPlus from 'lucide-react-native/icons/list-plus';
import Route from 'lucide-react-native/icons/route';
import X from 'lucide-react-native/icons/x';
import { useState } from 'react';
import { Image, Modal, Pressable, Text, TextInput, View } from 'react-native';

import type {
  CodexModelRecord,
} from '../../../../src/shared/project-space-api';
import type { CodexSessionTurnSettings } from '../../../../src/shared/codex-sessions-api';
import type { NativeReviewImage } from './native-review-api';

export interface NativeReviewModelChoice {
  effort?: string;
  model?: CodexModelRecord;
  serviceTier?: string | null;
}

export function NativeReviewComposer({
  active,
  compact = false,
  connecting,
  draft,
  error,
  images,
  modelChoice,
  models,
  onAttach,
  onChangeDraft,
  onChooseModel,
  onQueue,
  onRemoveImage,
  onRetry,
  onSend,
  onSteer,
  sending,
  theme,
}: {
  active: boolean;
  compact?: boolean;
  connecting: boolean;
  draft: string;
  error?: string;
  images: readonly NativeReviewImage[];
  modelChoice: NativeReviewModelChoice;
  models: readonly CodexModelRecord[];
  onAttach(): void;
  onChangeDraft(value: string): void;
  onChooseModel(value: NativeReviewModelChoice): void;
  onQueue(): void;
  onRemoveImage(image: NativeReviewImage): void;
  onRetry(): void;
  onSend(): void;
  onSteer(): void;
  sending: boolean;
  theme: 'dark' | 'light';
}) {
  const dark = theme === 'dark';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const disabled = sending || connecting || (!draft.trim() && !images.length);
  const foreground = dark ? '#f5f5f5' : '#18181b';
  const muted = dark ? '#737373' : '#71717a';
  const settings = turnSettings(modelChoice);
  return (
    <View className="min-w-0">
      {error ? (
        <View className="mb-2 flex-row items-center gap-2 px-3">
          <Text className="min-w-0 flex-1 text-xs text-red-400">{error}</Text>
          <Button size="sm" variant="ghost" onPress={onRetry}>
            Retry
          </Button>
        </View>
      ) : null}
      <View
        className={`min-w-0 overflow-hidden rounded-full ${
          compact ? 'min-h-12' : 'min-h-20'
        }`}
        style={{ backgroundColor: dark ? '#1b1b1b' : '#f0efec' }}
      >
        {images.length ? (
          <View className="flex-row gap-2 px-4 pt-3">
            {images.map((image) => (
              <View className="relative" key={image.id}>
                <Image
                  source={{ uri: image.previewUrl }}
                  style={{ borderRadius: 10, height: 54, width: 54 }}
                />
                <Pressable
                  accessibilityLabel={`Remove ${image.name}`}
                  className="absolute -right-1 -top-1 rounded-full bg-black p-1"
                  onPress={() => onRemoveImage(image)}
                >
                  <X color="white" size={11} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        <TextInput
          accessibilityLabel="Message Codex"
          className={`min-w-0 ${
            compact ? 'py-3 pl-12 pr-14 text-sm' : 'px-4 pt-4 text-base'
          }`}
          editable={!connecting && !sending}
          multiline={!compact}
          onChangeText={onChangeDraft}
          onSubmitEditing={() => !disabled && onSend()}
          placeholder={connecting ? 'Connecting to Codex…' : 'Do anything'}
          placeholderTextColor={muted}
          returnKeyType="send"
          style={{
            color: foreground,
            maxHeight: compact ? 48 : 112,
            minHeight: compact ? 48 : 48,
          }}
          value={draft}
        />
        {!compact ? (
          <View className="flex-row items-center gap-1 px-2 pb-2">
            <Button
              accessibilityLabel="Attach image"
              isDisabled={images.length >= 3 || sending}
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={onAttach}
            >
              <ImagePlus color={muted} size={18} />
            </Button>
            <Button
              className="min-w-0"
              size="sm"
              variant="ghost"
              onPress={() => setSettingsOpen(true)}
            >
              <Text
                className="max-w-44"
                numberOfLines={1}
                style={{ color: muted, fontSize: 13 }}
              >
                {modelChoice.model?.displayName ?? 'Default'}
                {modelChoice.effort ? ` ${effortLabel(modelChoice.effort)}` : ''}
              </Text>
              <ChevronDown color={muted} size={14} />
            </Button>
            <View className="flex-1" />
            {active ? (
              <>
                <Button
                  accessibilityLabel="Queue message"
                  isDisabled={disabled}
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  onPress={onQueue}
                >
                  <ListPlus color={muted} size={18} />
                </Button>
                <Button
                  accessibilityLabel="Steer active task"
                  isDisabled={disabled}
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  onPress={onSteer}
                >
                  <Route color={muted} size={18} />
                </Button>
              </>
            ) : null}
            <Button
              accessibilityLabel="Send message"
              isDisabled={disabled}
              isIconOnly
              size="sm"
              onPress={onSend}
            >
              {connecting || sending ? (
                <Spinner color={foreground} size="sm" />
              ) : (
                <ArrowUp color={dark ? '#111' : '#fff'} size={18} />
              )}
            </Button>
          </View>
        ) : (
          <>
            <View className="absolute left-1 top-1">
              <Button
                accessibilityLabel="Attach image"
                isDisabled={images.length >= 3 || sending}
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={onAttach}
              >
                <ImagePlus color={muted} size={17} />
              </Button>
            </View>
            <View className="absolute right-1 top-1">
              <Button
                accessibilityLabel="Send message"
                isDisabled={disabled}
                isIconOnly
                size="sm"
                onPress={onSend}
              >
                {connecting || sending ? (
                  <Spinner color={foreground} size="sm" />
                ) : (
                  <ArrowUp color={dark ? '#111' : '#fff'} size={17} />
                )}
              </Button>
            </View>
          </>
        )}
      </View>
      <ModelSettings
        choice={modelChoice}
        models={models}
        onChange={onChooseModel}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        visible={settingsOpen}
      />
    </View>
  );
}

function ModelSettings({
  choice,
  models,
  onChange,
  onClose,
  theme,
  visible,
}: {
  choice: NativeReviewModelChoice;
  models: readonly CodexModelRecord[];
  onChange(value: NativeReviewModelChoice): void;
  onClose(): void;
  theme: 'dark' | 'light';
  visible: boolean;
}) {
  const dark = theme === 'dark';
  const foreground = dark ? '#f5f5f5' : '#18181b';
  const muted = dark ? '#8b8b8b' : '#71717a';
  const model = choice.model ?? models.find((entry) => entry.isDefault);
  const efforts = model?.supportedReasoningEfforts ?? [];
  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      transparent
      visible={visible}
    >
      <Pressable className="flex-1 justify-end bg-black/30 p-4" onPress={onClose}>
        <Pressable
          className="gap-5 rounded-[28px] p-5"
          onPress={(event) => event.stopPropagation()}
          style={{ backgroundColor: dark ? '#1c1c1c' : '#f6f5f2' }}
        >
          <View className="flex-row items-center justify-between">
            <Text className="text-lg font-semibold" style={{ color: foreground }}>
              Model
            </Text>
            <Button isIconOnly size="sm" variant="ghost" onPress={onClose}>
              <X color={foreground} size={18} />
            </Button>
          </View>
          <View className="flex-row flex-wrap gap-2">
            {models.map((entry) => (
              <Button
                key={entry.id}
                size="sm"
                variant={entry.id === model?.id ? 'primary' : 'secondary'}
                onPress={() =>
                  onChange({
                    effort: entry.defaultReasoningEffort,
                    model: entry,
                    serviceTier: entry.defaultServiceTier,
                  })
                }
              >
                {entry.displayName}
              </Button>
            ))}
          </View>
          {efforts.length ? (
            <View className="gap-3">
              <Text className="text-sm font-medium" style={{ color: muted }}>
                Effort
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {efforts.map((entry) => (
                  <Button
                    key={entry.reasoningEffort}
                    size="sm"
                    variant={
                      entry.reasoningEffort === choice.effort
                        ? 'primary'
                        : 'secondary'
                    }
                    onPress={() =>
                      onChange({
                        ...choice,
                        model,
                        effort: entry.reasoningEffort,
                      })
                    }
                  >
                    {effortLabel(entry.reasoningEffort)}
                  </Button>
                ))}
              </View>
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function turnSettings(
  choice: NativeReviewModelChoice
): CodexSessionTurnSettings | undefined {
  return choice.model
    ? {
        effort: choice.effort,
        model: choice.model.model,
        serviceTier: choice.serviceTier,
      }
    : undefined;
}

function effortLabel(value: string) {
  return value
    .replace(/^xhigh$/i, 'Extra High')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
