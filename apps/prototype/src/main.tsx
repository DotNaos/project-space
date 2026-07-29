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

document.documentElement.classList.add('dark');
document.documentElement.dataset.theme = 'dark';

createRoot(root).render(
  <StrictMode>
    <PrototypeApp />
    <OptionalPrototypeFeatureBoundary>
      <Suspense fallback={null}>
        <PrototypeAnnotationBridge />
      </Suspense>
    </OptionalPrototypeFeatureBoundary>
  </StrictMode>
);
