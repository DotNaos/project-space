import type { PrototypeDesignGridMode } from "./prototype-design-grid-analysis";

const fibonacciGridSwatchTokens = [
  "var(--prototype-design-grid-fibonacci-1-swatch, #22d3ee)",
  "var(--prototype-design-grid-fibonacci-2-swatch, #60a5fa)",
  "var(--prototype-design-grid-fibonacci-3-swatch, #a78bfa)",
  "var(--prototype-design-grid-fibonacci-5-swatch, #f472b6)",
  "var(--prototype-design-grid-fibonacci-8-swatch, #fbbf24)",
  "var(--prototype-design-grid-fibonacci-13-swatch, #84cc16)",
  "var(--prototype-design-grid-fibonacci-21-swatch, #fb923c)",
  "var(--prototype-design-grid-fibonacci-34-swatch, #f87171)",
  "var(--prototype-design-grid-fibonacci-55-swatch, #2dd4bf)",
  "var(--prototype-design-grid-fibonacci-89-swatch, #818cf8)",
] as const;

const fibonacciGridLineOpacities = [
  5, 6.5, 8, 9.5, 12, 14, 16, 18, 20, 22,
] as const;
const linearGridLineOpacities = [2.5, 5, 9] as const;

function boundedIndex(index: number, count: number) {
  return Math.max(0, Math.min(Math.max(0, count - 1), index));
}

function gridSwatchToken(
  mode: PrototypeDesignGridMode,
  index: number,
  count: number,
) {
  if (mode === "fibonacci") {
    return (
      fibonacciGridSwatchTokens[
        Math.max(0, Math.min(fibonacciGridSwatchTokens.length - 1, index))
      ] ??
      fibonacciGridSwatchTokens.at(-1)!
    );
  }
  return "var(--prototype-design-grid-linear-swatch, #22d3ee)";
}

export function prototypeDesignGridLineToken(
  mode: PrototypeDesignGridMode,
  index: number,
  count: number,
  contrast = 100,
) {
  const opacity =
    mode === "fibonacci"
      ? (fibonacciGridLineOpacities[
          Math.max(
            0,
            Math.min(fibonacciGridLineOpacities.length - 1, index),
          )
        ] ?? 22)
      : (linearGridLineOpacities[boundedIndex(index, count)] ?? 9);
  const adjustedOpacity = Math.min(80, (opacity * contrast) / 100);
  return `color-mix(in srgb, ${gridSwatchToken(mode, index, count)} ${adjustedOpacity}%, transparent)`;
}

export function prototypeDesignGridSwatchToken(
  mode: PrototypeDesignGridMode,
  index: number,
  count: number,
) {
  return gridSwatchToken(mode, index, count);
}

export function prototypeDesignGridViolationTokens(
  mode: PrototypeDesignGridMode,
  index: number,
  count: number,
  contrast = 100,
) {
  const swatch = gridSwatchToken(mode, index, count);
  const strength = Math.max(0.4, Math.min(3, contrast / 100));
  return {
    fill: `color-mix(in srgb, ${swatch} ${Math.min(48, 16 * strength)}%, transparent)`,
    line: swatch,
    ring: `color-mix(in srgb, ${swatch} ${Math.min(62, 24 * strength)}%, transparent)`,
  };
}
