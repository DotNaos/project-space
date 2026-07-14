import { useEffect, useRef, type RefObject } from 'react';
import {
  topologySpringKeyframes,
  topologySprings,
  type TopologyWorkspacePhase
} from './project-topology-motion';

export interface TopologyWorkspaceMotionControl {
  onSettled?(result: {
    phase: 'closing' | 'opening';
    taskId: string;
    transition: number;
  }): void;
  phase: Extract<TopologyWorkspacePhase, 'closing' | 'open' | 'opening'>;
  transition: number;
}

export function useTopologyWorkspaceMotion(
  elementRef: RefObject<HTMLElement | null>,
  taskId: string,
  control?: TopologyWorkspaceMotionControl
) {
  const onSettledRef = useRef(control?.onSettled);
  onSettledRef.current = control?.onSettled;
  const phase = control?.phase;
  const transition = control?.transition;

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !phase || transition === undefined) return;
    if (phase === 'open') {
      element.style.opacity = '1';
      element.style.transform = 'translateY(0) scale(1)';
      return;
    }

    const reducedMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const finalProgress = phase === 'opening' ? 1 : 0;
    const finish = () => {
      element.style.opacity = String(finalProgress);
      element.style.transform = workspaceTransform(finalProgress);
      onSettledRef.current?.({ phase, taskId, transition });
    };
    if (reducedMotion || typeof element.animate !== 'function') {
      finish();
      return;
    }

    const spring = topologySprings.workspace;
    const keyframes = topologySpringKeyframes(spring).map(({ offset, progress }) => {
      const visualProgress = phase === 'opening' ? progress : 1 - progress;
      return {
        offset,
        opacity: Math.min(1, Math.max(0, visualProgress * 1.8)),
        transform: workspaceTransform(visualProgress)
      };
    });
    const animation = element.animate(keyframes, {
      duration: spring.durationMs,
      easing: 'linear',
      fill: 'forwards'
    });
    let cancelled = false;
    void animation.finished.then(() => {
      if (!cancelled) finish();
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      animation.cancel();
    };
  }, [elementRef, phase, taskId, transition]);
}

function workspaceTransform(progress: number) {
  const scale = 0.955 + progress * 0.045;
  const translateY = (1 - progress) * 18;
  return `translateY(${translateY}px) scale(${scale})`;
}
