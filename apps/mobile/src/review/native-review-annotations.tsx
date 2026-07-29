import { Button } from 'heroui-native';
import X from 'lucide-react-native/icons/x';
import { useState } from 'react';
import {
  type GestureResponderEvent,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

import type {
  PrototypeOrientation,
  PrototypeViewport,
} from '../prototype/prototype-state';

export interface NativeReviewAnnotation {
  comment: string;
  id: string;
  orientation: PrototypeOrientation;
  viewport: PrototypeViewport;
  x: number;
  y: number;
}

export function NativeReviewAnnotationLayer({
  active,
  annotations,
  onAdd,
  onRemove,
  orientation,
  theme,
  viewport,
}: {
  active: boolean;
  annotations: readonly NativeReviewAnnotation[];
  onAdd(annotation: NativeReviewAnnotation): void;
  onRemove(id: string): void;
  orientation: PrototypeOrientation;
  theme: 'dark' | 'light';
  viewport: PrototypeViewport;
}) {
  const [pending, setPending] = useState<Omit<NativeReviewAnnotation, 'comment'>>();
  const [comment, setComment] = useState('');
  const start = (event: GestureResponderEvent) => {
    if (!active) return;
    const { locationX, locationY } = event.nativeEvent;
    const target = event.currentTarget;
    target.measure((_x, _y, width, height) => {
      setPending({
        id: `annotation-${Date.now()}`,
        orientation,
        viewport,
        x: Math.round((locationX / Math.max(width, 1)) * 1000) / 10,
        y: Math.round((locationY / Math.max(height, 1)) * 1000) / 10,
      });
    });
  };
  return (
    <>
      <Pressable
        accessibilityLabel={
          active ? 'Tap the prototype to add a comment' : undefined
        }
        className="absolute inset-x-0 bottom-28 top-28 z-20"
        onPress={start}
        pointerEvents={active ? 'auto' : 'none'}
      >
        {annotations.map((annotation, index) => (
          <Pressable
            accessibilityLabel={`Remove comment ${index + 1}`}
            className="absolute h-8 w-8 items-center justify-center rounded-full bg-white shadow-lg"
            key={annotation.id}
            onPress={() => onRemove(annotation.id)}
            style={{
              left: `${annotation.x}%`,
              top: `${annotation.y}%`,
              transform: [{ translateX: -16 }, { translateY: -16 }],
            }}
          >
            <Text className="font-bold text-black">{index + 1}</Text>
          </Pressable>
        ))}
      </Pressable>
      <Modal
        animationType="fade"
        onRequestClose={() => setPending(undefined)}
        transparent
        visible={Boolean(pending)}
      >
        <Pressable
          className="flex-1 justify-end bg-black/30 p-4"
          onPress={() => setPending(undefined)}
        >
          <Pressable
            className="gap-4 rounded-[28px] p-5"
            onPress={(event) => event.stopPropagation()}
            style={{ backgroundColor: theme === 'dark' ? '#1c1c1c' : '#f6f5f2' }}
          >
            <View className="flex-row items-center justify-between">
              <Text
                className="text-lg font-semibold"
                style={{ color: theme === 'dark' ? '#fafafa' : '#18181b' }}
              >
                Add comment
              </Text>
              <Button
                accessibilityLabel="Cancel comment"
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => setPending(undefined)}
              >
                <X color={theme === 'dark' ? '#fafafa' : '#18181b'} size={18} />
              </Button>
            </View>
            <TextInput
              autoFocus
              className="min-h-24 rounded-2xl px-4 py-3"
              multiline
              onChangeText={setComment}
              placeholder="What should change here?"
              placeholderTextColor={theme === 'dark' ? '#737373' : '#71717a'}
              style={{
                backgroundColor: theme === 'dark' ? '#292929' : '#e9e8e5',
                color: theme === 'dark' ? '#fafafa' : '#18181b',
              }}
              value={comment}
            />
            <Button
              isDisabled={!comment.trim()}
              onPress={() => {
                if (!pending || !comment.trim()) return;
                onAdd({ ...pending, comment: comment.trim() });
                setComment('');
                setPending(undefined);
              }}
            >
              Add comment
            </Button>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export function annotationsAsPrompt(
  annotations: readonly NativeReviewAnnotation[]
) {
  if (!annotations.length) return '';
  return [
    '',
    'Prototype annotations:',
    ...annotations.map(
      (annotation, index) =>
        `${index + 1}. ${annotation.viewport} ${annotation.orientation} at ${annotation.x}% × ${annotation.y}%: ${annotation.comment}`
    ),
  ].join('\n');
}
