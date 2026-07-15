const CONTEXT_PANEL_DEFAULT_VIEWPORT_WIDTH = 1180;

export function shouldDefaultContextPanelOpen(viewportWidth: number) {
  return Number.isFinite(viewportWidth)
    && viewportWidth >= CONTEXT_PANEL_DEFAULT_VIEWPORT_WIDTH;
}
