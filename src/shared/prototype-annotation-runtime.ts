import {
  parsePrototypeAnnotationCommand,
  prototypeAnnotationEvent
} from './prototype-annotation-bridge';
import {
  createPrototypeAnnotationOverlay,
  type PrototypeAnnotationOverlay
} from './prototype-annotation-overlay';

export function installPrototypeAnnotationRuntime() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const embedded = window.parent !== window;
  const trustedParentOrigin = parentOrigin(document.referrer);
  let overlay: PrototypeAnnotationOverlay | undefined;
  let responseOrigin: string | undefined;

  const post = (message: ReturnType<typeof prototypeAnnotationEvent>) => {
    if (message && responseOrigin) window.parent.postMessage(message, responseOrigin);
  };
  const ensureOverlay = () => {
    overlay ??= createPrototypeAnnotationOverlay({
      document,
      window,
      onDelete: (annotation) => post(prototypeAnnotationEvent('delete', annotation)),
      onUpsert: (annotation) => post(prototypeAnnotationEvent('upsert', annotation))
    });
    return overlay;
  };
  const receive = (event: MessageEvent) => {
    const fromTrustedParent = embedded
      ? Boolean(trustedParentOrigin && event.origin === trustedParentOrigin)
      : event.source === window;
    if (!fromTrustedParent) return;
    const command = parsePrototypeAnnotationCommand(event.data);
    if (!command) return;
    responseOrigin = event.origin;
    if (command.action === 'disable') {
      overlay?.destroy();
      overlay = undefined;
      responseOrigin = undefined;
      return;
    }
    if (command.action === 'enable') {
      ensureOverlay();
      return;
    }
    if (command.action === 'clear') {
      overlay?.clear();
      post(prototypeAnnotationEvent('clear'));
      return;
    }
    ensureOverlay().toggle();
  };

  window.addEventListener('message', receive);
  window.parent.postMessage(prototypeAnnotationEvent('ready'), trustedParentOrigin ?? '*');
  return () => {
    window.removeEventListener('message', receive);
    overlay?.destroy();
  };
}

function parentOrigin(referrer: string) {
  if (!referrer) return undefined;
  try {
    return new URL(referrer).origin;
  } catch {
    return undefined;
  }
}
