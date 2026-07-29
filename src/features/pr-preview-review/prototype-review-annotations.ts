import { useCallback, useEffect, useRef, useState } from 'react';

import {
  parsePrototypeAnnotationEvent,
  prototypeAnnotationCommand,
  type PrototypeAnnotation,
  type PrototypeAnnotationCommand
} from '@/shared/prototype-annotation-bridge';

export function usePrototypeReviewAnnotations({
  enabled,
  targetKey,
  targetOrigin
}: {
  enabled: boolean;
  targetKey?: string;
  targetOrigin?: string;
}) {
  const [annotations, setAnnotations] = useState<PrototypeAnnotation[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sendCommand = useCallback((
    action: PrototypeAnnotationCommand['action']
  ) => {
    if (!enabled || !targetOrigin) return;
    iframeRef.current?.contentWindow?.postMessage(
      prototypeAnnotationCommand(action),
      targetOrigin
    );
  }, [enabled, targetOrigin]);

  useEffect(() => {
    setAnnotations([]);
  }, [targetKey]);

  useEffect(() => {
    if (!enabled) setAnnotations([]);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !targetOrigin) return;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        event.origin !== targetOrigin
      ) {
        return;
      }
      const annotationEvent = parsePrototypeAnnotationEvent(event.data);
      if (!annotationEvent) return;
      if (annotationEvent.action === 'ready') {
        sendCommand('enable');
        return;
      }
      if (annotationEvent.action === 'clear') {
        setAnnotations([]);
        return;
      }
      if (annotationEvent.action === 'delete') {
        setAnnotations((current) =>
          current.filter((annotation) => annotation.id !== annotationEvent.annotationId)
        );
        return;
      }
      setAnnotations((current) => {
        const withoutCurrent = current.filter(
          (annotation) => annotation.id !== annotationEvent.annotation.id
        );
        return [...withoutCurrent, annotationEvent.annotation].slice(-100);
      });
    };
    window.addEventListener('message', receive);
    return () => {
      sendCommand('disable');
      window.removeEventListener('message', receive);
    };
  }, [enabled, sendCommand, targetOrigin]);

  return {
    annotations,
    clearAnnotations() {
      sendCommand('clear');
      setAnnotations([]);
    },
    iframeRef,
    onFrameLoad() {
      sendCommand('enable');
    },
    toggleAnnotations() {
      sendCommand('toggle');
    }
  };
}
