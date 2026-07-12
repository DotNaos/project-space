export type ProjectChatAgentAvatarCategory =
  | 'artist'
  | 'detective'
  | 'gradient'
  | 'mythology'
  | 'science';

export const PROJECT_CHAT_GOLDEN_ANGLE = 137.50776405003785;

export function projectChatNameRequiresParent(category: string) {
  return category !== 'mythology';
}

export function projectChatAvatarHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function projectChatAvatarHue(name: string) {
  const colorIndex = projectChatAvatarHash(name.toLowerCase()) % 4096;
  return (colorIndex * PROJECT_CHAT_GOLDEN_ANGLE) % 360;
}

function fract(value: number) {
  return value - Math.floor(value);
}

function smooth(value: number) {
  return value * value * (3 - 2 * value);
}

function hash2(x: number, y: number, seed: number) {
  return fract(Math.sin(x * 127.1 + y * 311.7 + seed * 0.000013) * 43758.5453123);
}

function noise2(x: number, y: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smooth(xf);
  const v = smooth(yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * u;
  return top + ((c + (d - c) * u) - top) * v;
}

function fbm(x: number, y: number, seed: number, octaves = 5) {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let normalization = 0;
  for (let index = 0; index < octaves; index += 1) {
    sum += noise2(x * frequency, y * frequency, seed + index * 1013) * amplitude;
    normalization += amplitude;
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return sum / normalization;
}

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function mix(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (input: number) => {
    const value = (input + 1) % 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)] as const;
}

function palette(hue: number) {
  return [
    hslToRgb(hue - 18, 44, 7),
    hslToRgb(hue, 62, 20),
    hslToRgb(hue + 24, 76, 42),
    hslToRgb(hue + 48, 84, 68),
    hslToRgb(hue + 72, 52, 91)
  ];
}

function samplePalette(colors: ReturnType<typeof palette>, value: number) {
  const position = clamp(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(position));
  const amount = smooth(position - index);
  return [
    mix(colors[index][0], colors[index + 1][0], amount),
    mix(colors[index][1], colors[index + 1][1], amount),
    mix(colors[index][2], colors[index + 1][2], amount)
  ];
}

export function projectChatAvatarField(
  category: ProjectChatAgentAvatarCategory,
  x: number,
  y: number,
  seed: number
) {
  const qx = fbm(x * 1.8 + 3.1, y * 1.8 - 1.7, seed + 17, 4) - 0.5;
  const qy = fbm(x * 1.8 - 4.2, y * 1.8 + 2.4, seed + 71, 4) - 0.5;
  const wx = x + qx * 0.55;
  const wy = y + qy * 0.55;

  if (category === 'mythology') {
    const broad = fbm(wx * 1.15, wy * 1.15, seed + 211, 6);
    const erosion = fbm(wx * 4.4, wy * 4.4, seed + 313, 5);
    const cells = 0.5 + 0.5 * Math.cos((broad * 2.3 + erosion * 0.38) * Math.PI * 2);
    return clamp(broad * 0.68 + cells * 0.32);
  }
  if (category === 'artist') {
    const flow = fbm(wx * 1.55 + qy * 0.9, wy * 3.7 - qx * 0.35, seed + 401, 6);
    const branchA = Math.abs(Math.sin((wx * 3.4 + flow * 5.6) * Math.PI));
    const branchB = Math.abs(Math.sin((wy * 4.8 - wx * 1.2 + flow * 4.1) * Math.PI));
    const veins = Math.pow(1 - Math.min(branchA, branchB), 2.15);
    const pigment = fbm(wx * 5.2 + flow, wy * 2.1 - flow * 0.6, seed + 503, 5);
    return clamp(pigment * 0.62 + veins * 0.38);
  }
  if (category === 'science') {
    const radius = Math.hypot(wx + qx * 0.22, wy + qy * 0.22);
    const rings = 0.5 + 0.5 * Math.sin((radius * 11.5 + fbm(wx * 3.1, wy * 3.1, seed + 607, 4) * 2.2) * Math.PI);
    const tissue = fbm(wx * 4.5, wy * 4.5, seed + 709, 5);
    return clamp(rings * 0.47 + tissue * 0.53);
  }
  if (category === 'gradient') {
    const q1 = fbm(x * 1.35 + 2.2, y * 1.35 - 1.7, seed + 1001, 5);
    const q2 = fbm(x * 1.35 - 3.8, y * 1.35 + 2.9, seed + 1031, 5);
    const rx = fbm(x * 1.65 + 2.6 * q1 + 8.3, y * 1.65 + 2.6 * q2 + 2.8, seed + 1061, 5);
    const ry = fbm(x * 1.65 + 2.6 * q1 - 4.1, y * 1.65 + 2.6 * q2 + 7.4, seed + 1091, 5);
    const gx = x + 0.32 * (rx - 0.5);
    const gy = y + 0.32 * (ry - 0.5);
    const core = fbm(gx * 1.15 + 2.2 * rx, gy * 1.15 + 2.2 * ry, seed + 1121, 6);
    const sweep = 0.5 + 0.24 * Math.sin(gx * 1.8 + gy * 1.2) + 0.16 * q1 - 0.12 * q2;
    return clamp(core * 0.58 + sweep * 0.42);
  }
  const split = Math.abs(wx + fbm(wx * 2.4, wy * 2.4, seed + 811, 4) * 0.48);
  const rift = Math.exp(-split * 5.2);
  const shadow = Math.pow(fbm(wx * 2.3, wy * 2.3, seed + 907, 6), 1.45);
  return clamp(shadow * 0.72 + rift * 0.28);
}

export function renderProjectChatAgentAvatar(
  name: string,
  category: ProjectChatAgentAvatarCategory,
  width: number,
  height = width
) {
  const seed = projectChatAvatarHash(`${category}:${name}`);
  const colors = palette(projectChatAvatarHue(name));
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const nx = (px / width - 0.5) * 2.15;
      const ny = (py / height - 0.5) * 2.15;
      const radius = Math.hypot(nx, ny);
      const offset = (py * width + px) * 4;
      if (radius > 1) {
        pixels[offset + 3] = 0;
        continue;
      }
      const depth = 1 - clamp(radius);
      const field = projectChatAvatarField(category, nx, ny, seed);
      const value = clamp(field * 0.84 + depth * 0.16);
      const micro = (noise2(px * 0.45, py * 0.45, seed + 1201) - 0.5) * 0.035;
      const rgb = samplePalette(colors, clamp(value + micro));
      const light = 0.78 + 0.22 * depth;
      pixels[offset] = rgb[0] * 255 * light;
      pixels[offset + 1] = rgb[1] * 255 * light;
      pixels[offset + 2] = rgb[2] * 255 * light;
      pixels[offset + 3] = 255 * clamp((1 - radius) * 18);
    }
  }
  return pixels;
}
