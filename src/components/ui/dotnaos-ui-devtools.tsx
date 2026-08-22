import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import type { UiDevToolsProps } from '@dotnaos/ui/devtools';

type UiDevToolsComponent = ComponentType<UiDevToolsProps>;

/**
 * Project-neutral compatibility boundary for the published DotNaos review tools.
 * Remove the code-editor preload after https://github.com/DotNaos/ui/issues/78 ships.
 */
export function DotnaosUiDevTools(props: UiDevToolsProps) {
  const [DevTools, setDevTools] = useState<UiDevToolsComponent>();

  useEffect(() => {
    let mounted = true;
    void import('@dotnaos/ui/code-editor')
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      .then(() => import('@dotnaos/ui/devtools'))
      .then(({ UiDevTools }) => {
        if (mounted) setDevTools(() => UiDevTools);
      });
    return () => {
      mounted = false;
    };
  }, []);

  return DevTools ? <DevTools {...props} /> : null;
}
