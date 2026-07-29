import * as ImagePicker from 'expo-image-picker';
import { Button } from 'heroui-native';
import History from 'lucide-react-native/icons/messages-square';
import MessageSquarePlus from 'lucide-react-native/icons/message-square-plus';
import ScrollText from 'lucide-react-native/icons/scroll-text';
import { useEffect, useState } from 'react';
import { Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CodexModelRecord } from '../../../../src/shared/project-space-api';
import type { NativeReviewConfig, NativeReviewImage } from './native-review-api';
import {
  loadNativeReviewModels,
  removeNativeReviewImage,
  uploadNativeReviewImage,
} from './native-review-api';
import {
  annotationsAsPrompt,
  NativeReviewAnnotationLayer,
  type NativeReviewAnnotation,
} from './native-review-annotations';
import { NativeReviewChangelog } from './native-review-changelog';
import { NativeReviewChat } from './native-review-chat';
import {
  NativeReviewComposer,
  turnSettings,
  type NativeReviewModelChoice,
} from './native-review-composer';
import { useNativeCodexSession } from './use-native-codex-session';
import { useNativeReviewContext } from './use-native-review-context';
import type {
  PrototypeOrientation,
  PrototypeViewport,
} from '../prototype/prototype-state';

export function NativeReviewDock({
  config,
  orientation,
  theme,
  viewport,
}: {
  config: NativeReviewConfig;
  orientation: PrototypeOrientation;
  theme: 'dark' | 'light';
  viewport: PrototypeViewport;
}) {
  const { width } = useWindowDimensions();
  const safeArea = useSafeAreaInsets();
  const contextState = useNativeReviewContext(config);
  const context =
    contextState.state === 'available' ? contextState.context : undefined;
  const codex = useNativeCodexSession(config.origin, context);
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<NativeReviewImage[]>([]);
  const [imageError, setImageError] = useState<string>();
  const [models, setModels] = useState<CodexModelRecord[]>([]);
  const [modelChoice, setModelChoice] = useState<NativeReviewModelChoice>({});
  const [chatOpen, setChatOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [annotationsActive, setAnnotationsActive] = useState(false);
  const [annotations, setAnnotations] = useState<NativeReviewAnnotation[]>([]);
  const connected = context?.codex.state === 'available';
  const localCodex =
    context?.codex.state === 'available' ? context.codex : undefined;
  const compact = width < 520;
  const dark = theme === 'dark';
  const foreground = dark ? '#f5f5f5' : '#18181b';
  const muted = dark ? '#a3a3a3' : '#52525b';
  const liveResponse = codex.messages
    .filter(
      (item) =>
        item.kind === 'agent-message' && item.status === 'in-progress' && item.text
    )
    .at(-1);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    loadNativeReviewModels(config.origin)
      .then((catalogue) => {
        if (!active || catalogue.status !== 'success') return;
        setModels(catalogue.models);
        const initial = catalogue.models.find((model) => model.isDefault);
        if (initial) {
          setModelChoice({
            effort: initial.defaultReasoningEffort,
            model: initial,
            serviceTier: initial.defaultServiceTier,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [config.origin, connected]);

  const attach = async () => {
    setImageError(undefined);
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: true,
      mediaTypes: ['images'],
      quality: 0.9,
      selectionLimit: Math.max(1, 3 - images.length),
    });
    if (result.canceled) return;
    try {
      const uploaded = await Promise.all(
        result.assets
          .slice(0, 3 - images.length)
          .map((asset) => uploadNativeReviewImage(config.origin, asset))
      );
      setImages((current) => [...current, ...uploaded].slice(0, 3));
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'Image upload failed.');
    }
  };
  const removeImage = (image: NativeReviewImage) => {
    setImages((current) => current.filter((item) => item.id !== image.id));
    void removeNativeReviewImage(config.origin, image.id);
  };
  const message = () => `${draft.trim()}${annotationsAsPrompt(annotations)}`.trim();
  const clearAccepted = () => {
    setDraft('');
    setImages([]);
    setAnnotations([]);
    setAnnotationsActive(false);
  };
  const send = async (delivery?: 'new-turn' | 'steer') => {
    try {
      await codex.send(
        message(),
        images.map((image) => image.id),
        turnSettings(modelChoice),
        delivery
      );
      clearAccepted();
    } catch {
      // The hook keeps the exact error and the draft remains available.
    }
  };
  const queue = () => {
    codex.enqueue(
      message(),
      images.map((image) => image.id),
      turnSettings(modelChoice)
    );
    clearAccepted();
  };
  const error =
    imageError ??
    codex.error ??
    (contextState.state === 'unavailable' ? contextState.error : undefined) ??
    (context?.codex.state === 'unavailable'
      ? reasonLabel(context.codex.reason)
      : undefined);
  const connecting = contextState.state === 'loading' || codex.loading;

  return (
    <View className="absolute inset-0 z-50" pointerEvents="box-none">
      <NativeReviewAnnotationLayer
        active={annotationsActive}
        annotations={annotations}
        onAdd={(annotation) =>
          setAnnotations((current) => [...current, annotation])
        }
        onRemove={(id) =>
          setAnnotations((current) => current.filter((item) => item.id !== id))
        }
        orientation={orientation}
        theme={theme}
        viewport={viewport}
      />
      {liveResponse ? (
        <View
          className="absolute bottom-36 left-5 right-5 max-h-32 rounded-[22px] px-4 py-3 shadow-xl"
          pointerEvents="none"
          style={{ backgroundColor: dark ? '#1b1b1bf2' : '#f0efecf2' }}
        >
          <Text
            numberOfLines={4}
            style={{ color: foreground, fontSize: 14, lineHeight: 20 }}
          >
            {liveResponse.text}
          </Text>
        </View>
      ) : null}
      <View
        className="absolute bottom-0 left-0 right-0 gap-2 px-3 pt-2"
        pointerEvents="box-none"
        style={{ paddingBottom: Math.max(12, safeArea.bottom) }}
      >
        <View className="flex-row items-center justify-between gap-2">
          <Button
            accessibilityLabel="Open changelog"
            size="sm"
            variant="secondary"
            onPress={() => setChangelogOpen(true)}
          >
            <ScrollText color={muted} size={17} />
            {compact ? null : 'Changelog'}
          </Button>
          <View className="flex-row gap-2">
            <Button
              accessibilityLabel="Add prototype comments"
              isIconOnly
              size="sm"
              variant={annotationsActive ? 'primary' : 'secondary'}
              onPress={() => setAnnotationsActive((value) => !value)}
            >
              <MessageSquarePlus color={muted} size={17} />
            </Button>
            <Button
              accessibilityLabel="Open Codex conversation"
              isIconOnly
              size="sm"
              variant="secondary"
              onPress={() => setChatOpen(true)}
            >
              <History color={muted} size={17} />
            </Button>
          </View>
        </View>
        <NativeReviewComposer
          active={codex.active}
          compact
          connecting={connecting}
          draft={draft}
          error={error}
          images={images}
          modelChoice={modelChoice}
          models={models}
          onAttach={attach}
          onChangeDraft={setDraft}
          onChooseModel={setModelChoice}
          onQueue={queue}
          onRemoveImage={removeImage}
          onRetry={() => {
            contextState.retry();
            void codex.reload();
          }}
          onSend={() => void send(codex.active ? 'steer' : undefined)}
          onSteer={() => void send('steer')}
          sending={codex.sending}
          theme={theme}
        />
      </View>
      <NativeReviewChat
        active={codex.active}
        connecting={connecting}
        draft={draft}
        error={error}
        images={images}
        messages={codex.messages}
        modelChoice={modelChoice}
        models={models}
        onAttach={attach}
        onChangeDraft={setDraft}
        onChooseModel={setModelChoice}
        onClose={() => setChatOpen(false)}
        onQueue={queue}
        onReload={() => {
          contextState.retry();
          void codex.reload();
        }}
        onRemoveImage={removeImage}
        onRemoveQueued={codex.removeQueued}
        onSend={() => void send()}
        onSteer={() => void send('steer')}
        queue={codex.queue}
        sending={codex.sending}
        subtitle={
          localCodex
            ? `${localCodex.machineName} · Local`
            : 'Local Codex connection'
        }
        theme={theme}
        title={codex.result?.session.title ?? 'Local Codex task'}
        visible={chatOpen}
      />
      <NativeReviewChangelog
        context={context}
        onClose={() => setChangelogOpen(false)}
        pullRequestNumber={config.pullRequestNumber}
        theme={theme}
        visible={changelogOpen}
      />
    </View>
  );
}

function reasonLabel(reason: string) {
  const labels: Record<string, string> = {
    'checkout-unavailable': 'The local checkout could not be verified.',
    'codex-unavailable': 'Codex is unavailable on this machine.',
    'missing-thread': 'The local Review server has no owning Codex task.',
    'repository-mismatch': 'This Review server belongs to another repository.',
    'task-mismatch': 'This Review server belongs to another Codex task.',
  };
  return labels[reason] ?? 'The local Codex connection is unavailable.';
}
