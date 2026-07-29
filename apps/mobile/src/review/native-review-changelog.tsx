import { Button } from 'heroui-native';
import X from 'lucide-react-native/icons/x';
import { Modal, ScrollView, Text, View } from 'react-native';

import { pullRequestChangelogSnapshotFor } from '../../../../src/features/pr-preview-changelog/pull-request-changelog-snapshot';
import { pullRequestChangelogPresentation } from '../../../../src/shared/pr-preview-changelog-api';
import type { PrototypeReviewLocalContext } from '../../../../src/shared/prototype-review-local-api';

export function NativeReviewChangelog({
  context,
  onClose,
  pullRequestNumber,
  theme,
  visible,
}: {
  context?: PrototypeReviewLocalContext;
  onClose(): void;
  pullRequestNumber: number;
  theme: 'dark' | 'light';
  visible: boolean;
}) {
  const identity =
    context?.checkout.state === 'available'
      ? {
          headSha: context.checkout.headSha,
          pullRequestNumber,
          repositoryFullName: context.checkout.repositoryFullName,
        }
      : undefined;
  const presentation = identity
    ? pullRequestChangelogPresentation(
        pullRequestChangelogSnapshotFor(identity),
        identity
      )
    : undefined;
  const dark = theme === 'dark';
  return (
    <Modal animationType="slide" onRequestClose={onClose} visible={visible}>
      <View
        className="flex-1 px-5 pb-8 pt-14"
        style={{ backgroundColor: dark ? '#090909' : '#fafafa' }}
      >
        <View className="mb-6 flex-row items-center justify-between">
          <View>
            <Text
              className="text-2xl font-semibold"
              style={{ color: dark ? '#fafafa' : '#18181b' }}
            >
              Changelog
            </Text>
            <Text style={{ color: dark ? '#737373' : '#71717a' }}>
              Pull request #{pullRequestNumber}
            </Text>
          </View>
          <Button
            accessibilityLabel="Close changelog"
            isIconOnly
            onPress={onClose}
            variant="ghost"
          >
            <X color={dark ? '#fafafa' : '#18181b'} size={20} />
          </Button>
        </View>
        <ScrollView contentContainerStyle={{ gap: 20 }}>
          {!presentation || presentation.message ? (
            <Text
              style={{
                color: dark ? '#a3a3a3' : '#52525b',
                fontSize: 15,
                lineHeight: 23,
              }}
            >
              {presentation?.message ??
                'The exact local checkout could not be verified.'}
            </Text>
          ) : null}
          {presentation?.entries.map((entry) => (
            <View className="gap-3" key={entry.id}>
              <Text
                className="text-lg font-semibold"
                style={{ color: dark ? '#fafafa' : '#18181b' }}
              >
                {entry.summary}
              </Text>
              {entry.testing.map((step, index) => (
                <View className="flex-row gap-3" key={step}>
                  <Text style={{ color: dark ? '#737373' : '#71717a' }}>
                    {index + 1}.
                  </Text>
                  <Text
                    className="min-w-0 flex-1"
                    style={{
                      color: dark ? '#d4d4d4' : '#3f3f46',
                      lineHeight: 22,
                    }}
                  >
                    {step}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}
