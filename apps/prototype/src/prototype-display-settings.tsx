import { Dropdown, Header, Separator } from "@heroui/react";
import { Check, PaintBucket, ScanLine } from "lucide-react";

import type {
  PrototypePresentation,
  PrototypeScreenBackground,
  PrototypeTheme,
  PrototypeViewportKind,
} from "../../../src/shared/prototype-canvas";
import { projectSpaceCanvasBackground } from "./project-space-home";

const screenBackgroundLabels: Record<PrototypeScreenBackground, string> = {
  app: "Match app",
  black: "Black",
  white: "White",
};

export function prototypeScreenBackgroundColor(
  background: PrototypeScreenBackground,
  theme: PrototypeTheme,
) {
  if (background === "black") return "#000000";
  if (background === "white") return "#ffffff";
  return projectSpaceCanvasBackground(theme);
}

export function PrototypeDisplaySettings({
  onChange,
  presentation,
  viewport,
}: {
  onChange(value: PrototypePresentation): void;
  presentation: PrototypePresentation;
  viewport: PrototypeViewportKind;
}) {
  const safeAreaAvailable =
    viewport === "phone" && presentation.showDeviceFrame;
  const displayCustomized =
    presentation.showSafeArea || presentation.screenBackground !== "app";

  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label="Prototype display settings"
        aria-pressed={displayCustomized}
        className="prototype-hud__frame"
        data-active={displayCustomized}
      >
        <PaintBucket aria-hidden className="size-4" />
      </Dropdown.Trigger>
      <Dropdown.Popover
        className="prototype-hud__popover"
        offset={6}
        placement="bottom left"
      >
        <Dropdown.Menu
          aria-label="Prototype display settings"
          disabledKeys={safeAreaAvailable ? [] : ["safe-area"]}
          onAction={(key) => {
            const action = String(key);
            if (action === "safe-area") {
              onChange({
                ...presentation,
                showSafeArea: !presentation.showSafeArea,
              });
              return;
            }
            if (action.startsWith("background:")) {
              const screenBackground = action.slice(
                "background:".length,
              ) as PrototypeScreenBackground;
              onChange({ ...presentation, screenBackground });
            }
          }}
        >
          <Dropdown.Section>
            <Header className="prototype-hud__menu-header">Preview</Header>
            <Dropdown.Item
              className="prototype-hud__menu-item"
              id="safe-area"
              textValue="Safe area overlay"
            >
              <ScanLine aria-hidden className="size-3.5 shrink-0" />
              <span className="flex-1">Safe area overlay</span>
              {presentation.showSafeArea && safeAreaAvailable ? (
                <Check aria-hidden className="size-3.5 shrink-0" />
              ) : null}
            </Dropdown.Item>
          </Dropdown.Section>
          <Separator className="prototype-hud__menu-separator" />
          <Dropdown.Section>
            <Header className="prototype-hud__menu-header">
              Screen background
            </Header>
            {(Object.keys(
              screenBackgroundLabels,
            ) as PrototypeScreenBackground[]).map((background) => (
              <Dropdown.Item
                className="prototype-hud__menu-item"
                id={`background:${background}`}
                key={background}
                textValue={screenBackgroundLabels[background]}
              >
                <span
                  aria-hidden
                  className="prototype-hud__background-swatch"
                  data-background={background}
                />
                <span className="flex-1">
                  {screenBackgroundLabels[background]}
                </span>
                {presentation.screenBackground === background ? (
                  <Check aria-hidden className="size-3.5 shrink-0" />
                ) : null}
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
