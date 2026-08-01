import type { LocalBox } from "./prototype-design-analysis";

export interface PrototypeDesignPoint {
  x: number;
  y: number;
}

export function prototypeDesignAuditRoot(
  screen: HTMLElement,
  overlay: HTMLElement,
) {
  const activeDialog = [...screen.querySelectorAll<HTMLElement>("[role='dialog']")]
    .reverse()
    .find((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        !element.closest("[aria-hidden='true']")
      );
    });
  if (activeDialog) return activeDialog;
  return [...screen.children].find(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element !== overlay,
  );
}

interface VisibleEdges {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

function isVisuallyBounded(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  const hasBackground = !["rgba(0, 0, 0, 0)", "transparent"].includes(
    style.backgroundColor,
  );
  const hasBorder =
    Number.parseFloat(style.borderTopWidth) > 0 ||
    Number.parseFloat(style.borderRightWidth) > 0 ||
    Number.parseFloat(style.borderBottomWidth) > 0 ||
    Number.parseFloat(style.borderLeftWidth) > 0;
  return hasBackground || hasBorder;
}

export function prototypeDesignVisibleEdges(
  element: HTMLElement,
): VisibleEdges {
  const style = window.getComputedStyle(element);
  const backgroundEdge = !["rgba(0, 0, 0, 0)", "transparent"].includes(
    style.backgroundColor,
  )
    ? 1
    : 0;
  return {
    bottom: Math.max(
      backgroundEdge,
      Number.parseFloat(style.borderBottomWidth),
    ),
    left: Math.max(backgroundEdge, Number.parseFloat(style.borderLeftWidth)),
    right: Math.max(backgroundEdge, Number.parseFloat(style.borderRightWidth)),
    top: Math.max(backgroundEdge, Number.parseFloat(style.borderTopWidth)),
  };
}

export function prototypeDesignGridExemptEdges(element: HTMLElement) {
  const edges = new Set<"bottom" | "left" | "right" | "top">();
  const style = window.getComputedStyle(element);
  const parentStyle = element.parentElement
    ? window.getComputedStyle(element.parentElement)
    : null;
  const parentDirection = parentStyle?.flexDirection ?? "row";
  if (Number.parseFloat(style.flexGrow) > 0) {
    const growthEdges = parentDirection.startsWith("column")
      ? (["top", "bottom"] as const)
      : (["left", "right"] as const);
    growthEdges.forEach((edge) => edges.add(edge));
  }
  if (parentStyle?.display === "flex") {
    const horizontalCenter = parentDirection.startsWith("column")
      ? parentStyle.alignItems === "center"
      : parentStyle.justifyContent === "center";
    const verticalCenter = parentDirection.startsWith("column")
      ? parentStyle.justifyContent === "center"
      : parentStyle.alignItems === "center";
    if (horizontalCenter) {
      (["left", "right"] as const).forEach((edge) => edges.add(edge));
    }
    if (verticalCenter) {
      (["top", "bottom"] as const).forEach((edge) => edges.add(edge));
    }
  }
  if (parentStyle?.display === "grid") {
    (["left", "right"] as const).forEach((edge) => edges.add(edge));
  }
  const computedMap = element.computedStyleMap?.();
  if (
    String(computedMap?.get("margin-left")) === "auto" &&
    String(computedMap?.get("margin-right")) === "auto"
  ) {
    (["left", "right"] as const).forEach((edge) => edges.add(edge));
  }
  return [...edges];
}

export function prototypeDesignInspectableElement(
  target: EventTarget | null,
  screen: HTMLElement,
) {
  if (!(target instanceof HTMLElement) || target === screen) return null;
  let element: HTMLElement | null = target;
  while (element && element !== screen) {
    if (
      element.matches(
        "button, a, textarea, select, h1, h2, h3, h4, [role='dialog'], [role='listbox'], [role='navigation']",
      ) ||
      isVisuallyBounded(element)
    ) {
      return element;
    }
    element = element.parentElement;
  }
  return target;
}

export function prototypeDesignElementLabel(element: HTMLElement) {
  const role = element.getAttribute("role");
  const className = [...element.classList].find(
    (name) => !name.includes(":") && !name.startsWith("@"),
  );
  return `${element.tagName.toLowerCase()}${role ? `[${role}]` : ""}${className ? `.${className}` : ""}`;
}

export function prototypeDesignElementPath(
  element: HTMLElement,
  root: HTMLElement,
) {
  const segments: string[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== root) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) return null;
    const index = [...parent.children].indexOf(current);
    if (index < 0) return null;
    segments.unshift(`${current.tagName.toLowerCase()}:nth-child(${index + 1})`);
    current = parent;
  }
  return current === root ? segments.join(" > ") : null;
}

export function prototypeDesignDescendantAnchors(target: HTMLElement) {
  return [...target.children].filter((element): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const isTextOnly =
      element.children.length === 0 &&
      element.matches("span, p, h1, h2, h3, h4, h5, h6, label, small, strong");
    return !isTextOnly;
  });
}

export function prototypeDesignInnerElement(
  eventTarget: EventTarget | null,
  target: HTMLElement,
  screen: HTMLElement,
) {
  let candidate = prototypeDesignInspectableElement(eventTarget, screen);
  if (!candidate || candidate === target || !target.contains(candidate)) {
    return null;
  }
  while (candidate.parentElement && candidate.parentElement !== target) {
    candidate = candidate.parentElement;
  }
  return candidate.parentElement === target ? candidate : null;
}

export function prototypeDesignInspectableParent(
  target: HTMLElement,
  screen: HTMLElement,
) {
  let parent = target.parentElement;
  while (parent && parent !== screen) {
    if (
      parent.matches(
        "button, a, textarea, select, h1, h2, h3, h4, [role='dialog'], [role='listbox'], [role='navigation']",
      ) ||
      isVisuallyBounded(parent)
    ) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

export function prototypeDesignLocalBox(
  element: HTMLElement,
  screenRect: DOMRect,
  scaleX: number,
  scaleY: number,
): LocalBox {
  const rect = element.getBoundingClientRect();
  const left = (rect.left - screenRect.left) / scaleX;
  const top = (rect.top - screenRect.top) / scaleY;
  const width = rect.width / scaleX;
  const height = rect.height / scaleY;
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
  };
}

export function prototypeDesignLocalPoint(
  event: PointerEvent,
  screen: HTMLElement,
): PrototypeDesignPoint {
  const screenRect = screen.getBoundingClientRect();
  const scaleX = screenRect.width / screen.clientWidth;
  const scaleY = screenRect.height / screen.clientHeight;
  return {
    x: (event.clientX - screenRect.left) / scaleX,
    y: (event.clientY - screenRect.top) / scaleY,
  };
}

export function prototypeDesignPointDistance(
  start: PrototypeDesignPoint,
  end: PrototypeDesignPoint,
) {
  return Math.hypot(end.x - start.x, end.y - start.y);
}
