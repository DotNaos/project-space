export function shouldAutoOpenCodexBrowser({
  activeTurnId,
  browserState,
  browserTurnId,
  manualCollapsedTurn,
  openedTurns
}: {
  activeTurnId?: string;
  browserState?: 'ended' | 'live' | 'loading' | 'never-used' | 'unavailable';
  browserTurnId?: string;
  manualCollapsedTurn?: string;
  openedTurns: ReadonlySet<string>;
}) {
  if (!activeTurnId || browserTurnId !== activeTurnId) return false;
  return (browserState === 'loading' || browserState === 'live')
    && manualCollapsedTurn !== browserTurnId
    && !openedTurns.has(browserTurnId);
}

export function clampCodexChatSplitPercent(value: number) {
  return Math.min(72, Math.max(38, value));
}
