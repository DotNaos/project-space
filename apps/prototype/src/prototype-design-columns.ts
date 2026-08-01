export interface PrototypeDesignColumnGrid {
  columnWidth: number;
  count: 4 | 8 | 12;
  gutter: number;
  margin: number;
}

export function prototypeDesignResponsiveColumns(
  width: number,
): PrototypeDesignColumnGrid {
  const preset = width < 600
    ? { count: 4 as const, gutter: 12, margin: 16 }
    : width < 1100
      ? { count: 8 as const, gutter: 16, margin: 24 }
      : { count: 12 as const, gutter: 24, margin: 32 };
  const usableWidth = Math.max(
    0,
    width - preset.margin * 2 - preset.gutter * (preset.count - 1),
  );
  return {
    ...preset,
    columnWidth: usableWidth / preset.count,
  };
}
