export function shouldShowProjectSpaceSessionGate({
  currentUserId,
  isCheckingSession,
  isLoaded,
  verifiedUserId
}: {
  currentUserId?: string;
  isCheckingSession: boolean;
  isLoaded: boolean;
  verifiedUserId?: string;
}) {
  return !isLoaded || (
    isCheckingSession && (!currentUserId || verifiedUserId !== currentUserId)
  );
}
