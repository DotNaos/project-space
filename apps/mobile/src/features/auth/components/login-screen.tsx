import { Button, Card } from 'heroui-native';
import { ActivityIndicator, Text, View } from 'react-native';

interface LoginScreenProps {
  authError: string | null;
  callbackUrl: string | null;
  isConfigured: boolean;
  isBusy: boolean;
  onLogin(): void;
}

export function LoginScreen({
  authError,
  callbackUrl,
  isConfigured,
  isBusy,
  onLogin,
}: LoginScreenProps) {
  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <Card className="w-full max-w-[420px] rounded-[28px] bg-surface px-1 py-1">
        <Card.Body className="gap-6 px-6 py-7">
          <View className="gap-2">
            <Text className="text-3xl font-semibold text-foreground">
              Sign in with GitHub
            </Text>
            <Text className="text-base leading-6 text-muted">
              Start simple. Log in, choose which repositories should count as projects,
              then work with one project per screen.
            </Text>
          </View>

          <Button
            variant="primary"
            isDisabled={!isConfigured || isBusy}
            onPress={onLogin}
          >
            Continue with GitHub
          </Button>

          {!isConfigured ? (
            <View className="rounded-[20px] bg-default px-4 py-4">
              <Text className="text-sm font-medium text-foreground">
                GitHub OAuth is not configured yet.
              </Text>
              <Text className="mt-2 text-sm leading-6 text-muted">
                Add `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in
                `apps/mobile/.env.local`, then register this callback URL in your GitHub
                OAuth app:
              </Text>
              <Text className="mt-3 text-sm font-medium text-foreground">
                {callbackUrl ?? 'http://127.0.0.1:8787/auth/github/callback'}
              </Text>
            </View>
          ) : null}

          {isBusy ? (
            <View className="flex-row items-center gap-3">
              <ActivityIndicator />
              <Text className="text-sm text-muted">Finishing GitHub login…</Text>
            </View>
          ) : null}

          {authError ? (
            <View className="rounded-[20px] bg-[#fff1eb] px-4 py-4">
              <Text className="text-sm font-medium text-[#8a2d0b]">
                {authError}
              </Text>
            </View>
          ) : null}
        </Card.Body>
      </Card>
    </View>
  );
}
