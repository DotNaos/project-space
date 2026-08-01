import { useCallback, useMemo, useState } from "react";

import type {
  PrototypeDesignFibonacciStep,
  PrototypeDesignGridMode,
} from "./prototype-design-grid-analysis";
import { prototypeDesignFinerFibonacciSteps } from "./prototype-design-grid-analysis";
import { prototypeDesignElementPath } from "./prototype-design-dom";

export interface PrototypeDesignLayerGrid {
  contrast: number;
  fibonacciSteps: PrototypeDesignFibonacciStep[];
  layerPath: string;
  mode: PrototypeDesignGridMode;
  size: number;
}

export function usePrototypeLayerGrids({
  contrast,
  fibonacciSteps,
  mode,
  size,
}: Omit<PrototypeDesignLayerGrid, "layerPath">) {
  const [profiles, setProfiles] = useState<PrototypeDesignLayerGrid[]>([]);

  const apply = useCallback(
    (target: HTMLElement, root: HTMLElement) => {
      const layerPath = prototypeDesignElementPath(target, root);
      if (!layerPath) return;
      const parentProfile = profiles
        .filter((candidate) => layerPath.startsWith(`${candidate.layerPath} > `))
        .sort((first, second) => second.layerPath.length - first.layerPath.length)[0];
      const parentMultiplier = parentProfile?.fibonacciSteps.find(
        (step) => step.visible,
      )?.multiplier;
      const profile: PrototypeDesignLayerGrid = {
        contrast,
        fibonacciSteps:
          mode === "fibonacci"
            ? prototypeDesignFinerFibonacciSteps(
                fibonacciSteps,
                parentMultiplier,
              )
            : fibonacciSteps.map((step) => ({ ...step })),
        layerPath,
        mode,
        size,
      };
      setProfiles((current) => [
        ...current.filter((candidate) => candidate.layerPath !== layerPath),
        profile,
      ]);
    },
    [contrast, fibonacciSteps, mode, profiles, size],
  );

  const remove = useCallback((target: HTMLElement, root: HTMLElement) => {
    const layerPath = prototypeDesignElementPath(target, root);
    if (!layerPath) return;
    setProfiles((current) => current.filter(
      (candidate) => candidate.layerPath !== layerPath,
    ));
  }, []);

  const profileFor = useCallback(
    (target: HTMLElement | null, root: HTMLElement | null) => {
      const layerPath = target && root
        ? prototypeDesignElementPath(target, root)
        : null;
      return layerPath
        ? profiles.find((profile) => profile.layerPath === layerPath) ?? null
        : null;
    },
    [profiles],
  );

  return useMemo(
    () => ({ apply, profileFor, remove }),
    [apply, profileFor, remove],
  );
}
