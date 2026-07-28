import { Button, Tabs } from 'heroui-native';
import type { LucideIcon } from 'lucide-react-native';
import AppWindow from 'lucide-react-native/icons/app-window';
import Globe2 from 'lucide-react-native/icons/earth';
import Eye from 'lucide-react-native/icons/eye';
import EyeOff from 'lucide-react-native/icons/eye-off';
import Maximize2 from 'lucide-react-native/icons/maximize-2';
import Minimize2 from 'lucide-react-native/icons/minimize-2';
import Moon from 'lucide-react-native/icons/moon';
import Monitor from 'lucide-react-native/icons/monitor';
import RotateCw from 'lucide-react-native/icons/rotate-cw';
import Smartphone from 'lucide-react-native/icons/smartphone';
import Sun from 'lucide-react-native/icons/sun';
import TabletIcon from 'lucide-react-native/icons/tablet';
import { View } from 'react-native';

import type { PrototypeTheme, PrototypeViewport } from './prototype-state';

type PrototypeSurface = 'expo' | 'web';
type PrototypeActionIconKind =
  | 'enter-fullscreen'
  | 'exit-fullscreen'
  | 'hide-frame'
  | 'light-mode'
  | 'rotate'
  | 'show-frame'
  | 'dark-mode';

const deviceIcons: Record<PrototypeViewport, LucideIcon> = {
  desktop: Monitor,
  phone: Smartphone,
  tablet: TabletIcon,
};

const surfaceIcons: Record<PrototypeSurface, LucideIcon> = {
  expo: AppWindow,
  web: Globe2,
};

const actionIcons: Record<PrototypeActionIconKind, LucideIcon> = {
  'enter-fullscreen': Maximize2,
  'exit-fullscreen': Minimize2,
  'hide-frame': EyeOff,
  'light-mode': Sun,
  rotate: RotateCw,
  'show-frame': Eye,
  'dark-mode': Moon,
};

const hudPalettes: Record<
  PrototypeTheme,
  {
    background: string;
    foreground: string;
    muted: string;
    selected: string;
  }
> = {
  dark: {
    background: 'rgba(18, 18, 18, 0.96)',
    foreground: '#f5f5f5',
    muted: '#a3a3a3',
    selected: 'rgba(82, 82, 91, 0.85)',
  },
  light: {
    background: 'rgba(245, 244, 240, 0.96)',
    foreground: '#27272a',
    muted: '#71717a',
    selected: '#ffffff',
  },
};

function labelClass(isSelected: boolean) {
  return isSelected ? 'font-medium' : '';
}

function PrototypeDeviceIcon({
  palette,
  isSelected,
  viewport,
}: {
  palette: (typeof hudPalettes)[PrototypeTheme];
  isSelected: boolean;
  viewport: PrototypeViewport;
}) {
  const color = isSelected ? palette.foreground : palette.muted;
  const Icon = deviceIcons[viewport];
  return <Icon color={color} size={14} strokeWidth={2} />;
}

function PrototypeSurfaceIcon({
  palette,
  isSelected,
  surface,
}: {
  palette: (typeof hudPalettes)[PrototypeTheme];
  isSelected: boolean;
  surface: PrototypeSurface;
}) {
  const color = isSelected ? palette.foreground : palette.muted;
  const Icon = surfaceIcons[surface];
  return <Icon color={color} size={14} strokeWidth={2} />;
}

function PrototypeActionIcon({
  color,
  kind,
}: {
  color: string;
  kind: PrototypeActionIconKind;
}) {
  const Icon = actionIcons[kind];
  return <Icon color={color} size={16} strokeWidth={2} />;
}

export function PrototypeSurfaceTabs({
  onChange,
  surface,
  theme,
}: {
  onChange(surface: PrototypeSurface): void;
  surface: PrototypeSurface;
  theme: PrototypeTheme;
}) {
  const palette = hudPalettes[theme];

  return (
    <Tabs
      accessibilityLabel="Prototype app"
      onValueChange={(value) => onChange(value as PrototypeSurface)}
      value={surface}
      variant="primary"
    >
      <Tabs.List style={{ backgroundColor: palette.background }}>
        <Tabs.Indicator style={{ backgroundColor: palette.selected }} />
        <Tabs.Trigger value="web">
          {({ isSelected }) => (
            <View className="flex-row items-center gap-2">
              <PrototypeSurfaceIcon
                isSelected={isSelected}
                palette={palette}
                surface="web"
              />
              <Tabs.Label
                className={labelClass(isSelected)}
                style={{
                  color: isSelected ? palette.foreground : palette.muted,
                }}
              >
                Web
              </Tabs.Label>
            </View>
          )}
        </Tabs.Trigger>
        <Tabs.Trigger value="expo">
          {({ isSelected }) => (
            <View className="flex-row items-center gap-2">
              <PrototypeSurfaceIcon
                isSelected={isSelected}
                palette={palette}
                surface="expo"
              />
              <Tabs.Label
                className={labelClass(isSelected)}
                style={{
                  color: isSelected ? palette.foreground : palette.muted,
                }}
              >
                Native
              </Tabs.Label>
            </View>
          )}
        </Tabs.Trigger>
      </Tabs.List>
    </Tabs>
  );
}

export function PrototypePresentationControls({
  fullscreen,
  onFullscreenToggle,
  onRotate,
  onThemeToggle,
  rotateDisabled,
  theme,
}: {
  fullscreen: boolean;
  onFullscreenToggle(): void;
  onRotate(): void;
  onThemeToggle(): void;
  rotateDisabled: boolean;
  theme: PrototypeTheme;
}) {
  const palette = hudPalettes[theme];

  return (
    <View
      className="absolute right-3 top-2 z-50 flex-row items-center gap-1 rounded-2xl p-1"
      style={{ backgroundColor: palette.background }}
    >
      <Button
        accessibilityLabel={
          theme === 'dark' ? 'Use light mode' : 'Use dark mode'
        }
        isIconOnly
        className="h-9 w-9 px-0"
        feedbackVariant="scale"
        size="sm"
        variant="ghost"
        onPress={onThemeToggle}
      >
        <PrototypeActionIcon
          color={palette.foreground}
          kind={theme === 'dark' ? 'light-mode' : 'dark-mode'}
        />
      </Button>
      <Button
        accessibilityLabel="Rotate device"
        isDisabled={rotateDisabled}
        isIconOnly
        className="h-9 w-9 px-0"
        feedbackVariant="scale"
        size="sm"
        variant="ghost"
        onPress={onRotate}
      >
        <PrototypeActionIcon color={palette.foreground} kind="rotate" />
      </Button>
      <Button
        accessibilityLabel={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        isIconOnly
        className="h-9 w-9 px-0"
        feedbackVariant="scale"
        size="sm"
        variant="ghost"
        onPress={onFullscreenToggle}
      >
        <PrototypeActionIcon
          color={palette.foreground}
          kind={fullscreen ? 'exit-fullscreen' : 'enter-fullscreen'}
        />
      </Button>
    </View>
  );
}

export function PrototypeFrameControl({
  onFrameToggle,
  showDeviceFrame,
  theme,
}: {
  onFrameToggle(): void;
  showDeviceFrame: boolean;
  theme: PrototypeTheme;
}) {
  const palette = hudPalettes[theme];

  return (
    <View
      className="rounded-2xl p-1"
      style={{ backgroundColor: palette.background }}
    >
      <Button
        accessibilityLabel={
          showDeviceFrame ? 'Hide device frame' : 'Show device frame'
        }
        isIconOnly
        className="h-9 w-9 px-0"
        feedbackVariant="scale"
        size="sm"
        variant="ghost"
        onPress={onFrameToggle}
      >
        <PrototypeActionIcon
          color={palette.foreground}
          kind={showDeviceFrame ? 'hide-frame' : 'show-frame'}
        />
      </Button>
    </View>
  );
}

export function PrototypeViewportTabs({
  onChange,
  theme,
  viewport,
}: {
  onChange(viewport: PrototypeViewport): void;
  theme: PrototypeTheme;
  viewport: PrototypeViewport;
}) {
  const palette = hudPalettes[theme];

  return (
    <Tabs
      accessibilityLabel="Prototype device"
      onValueChange={(value) => onChange(value as PrototypeViewport)}
      value={viewport}
      variant="primary"
    >
      <Tabs.List style={{ backgroundColor: palette.background }}>
        <Tabs.ScrollView
          contentContainerClassName="min-w-full"
          scrollAlign="center"
          showsHorizontalScrollIndicator={false}
        >
          <Tabs.Indicator
            style={{ backgroundColor: palette.selected }}
            animation={{
              translateX: {
                config: { damping: 120, stiffness: 1200 },
                type: 'spring',
              },
            }}
          />
          {(['phone', 'tablet', 'desktop'] as const).map((value) => (
            <Tabs.Trigger key={value} value={value}>
              {({ isSelected }) => (
                <View className="flex-row items-center gap-2">
                  <PrototypeDeviceIcon
                    isSelected={isSelected}
                    palette={palette}
                    viewport={value}
                  />
                  <Tabs.Label
                    className={labelClass(isSelected)}
                    style={{
                      color: isSelected ? palette.foreground : palette.muted,
                    }}
                  >
                    {value[0]!.toUpperCase() + value.slice(1)}
                  </Tabs.Label>
                </View>
              )}
            </Tabs.Trigger>
          ))}
        </Tabs.ScrollView>
      </Tabs.List>
    </Tabs>
  );
}
