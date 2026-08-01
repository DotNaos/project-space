import { useEffect } from "react";

import type { PrototypeDesignStatusSnapshot } from "./prototype-design-settings";

export function usePrototypeDesignStatus(
  onChange: ((snapshot: PrototypeDesignStatusSnapshot) => void) | undefined,
  selected: boolean,
  gridViolations: number,
  gridViolationEdges: number,
  guideViolations: number,
  scope: PrototypeDesignStatusSnapshot["scope"],
  approvedAncestors: number,
  canEnterLayer: boolean,
  currentScopeApproved: boolean,
  nextFix: string | null,
  remainingFixes: number,
) {
  useEffect(() => {
    onChange?.({
      approvedAncestors,
      canEnterLayer,
      currentScopeApproved,
      gridViolationEdges,
      gridViolations,
      guideViolations,
      nextFix,
      remainingFixes,
      scope,
      selected,
    });
  }, [
    approvedAncestors,
    canEnterLayer,
    currentScopeApproved,
    gridViolationEdges,
    gridViolations,
    guideViolations,
    nextFix,
    onChange,
    remainingFixes,
    scope,
    selected,
  ]);
}
