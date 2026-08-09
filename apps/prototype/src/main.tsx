import {
  Component,
  lazy,
  StrictMode,
  Suspense,
  type ErrorInfo,
  type ReactNode
} from 'react';
import { createRoot } from 'react-dom/client';

import '@/app/index.css';
import { PreviewSurfaceSwitcher } from '@/features/pr-preview-navigation/preview-surface-switcher';
import { previewPullRequestNumberFromHostname } from '@/shared/preview-host';
import { PrototypeApp } from './prototype-app';

const PrototypeAnnotationBridge = lazy(async () => {
  const bridge = await import('./prototype-annotation-bridge');
  return { default: bridge.PrototypeAnnotationBridge };
});

class OptionalPrototypeFeatureBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('Optional prototype tooling could not be loaded.', error, info);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Prototype root container not found.');
const embedded = new URLSearchParams(window.location.search).get('embedded') === '1';
const previewPullRequestNumber = previewPullRequestNumberFromHostname(window.location.hostname);

document.documentElement.classList.add('dark');
document.documentElement.dataset.theme = 'dark';

createRoot(root).render(
  <StrictMode>
    <PrototypeApp />
    {!embedded && previewPullRequestNumber ? (
      <PreviewSurfaceSwitcher
        className="fixed left-1/2 top-3 z-[80] -translate-x-1/2"
        current="prototype"
        pullRequestNumber={previewPullRequestNumber}
      />
    ) : null}
    <OptionalPrototypeFeatureBoundary>
      <Suspense fallback={null}>
        <PrototypeAnnotationBridge />
      </Suspense>
    </OptionalPrototypeFeatureBoundary>
  </StrictMode>
);
