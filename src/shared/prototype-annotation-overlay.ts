import type { PrototypeAnnotation } from './prototype-annotation-bridge';

interface AnnotationEntry {
  annotation: PrototypeAnnotation;
  marker: HTMLButtonElement;
  target: Element;
}

interface PrototypeAnnotationOverlayOptions {
  document: Document;
  onDelete(annotation: PrototypeAnnotation): void;
  onUpsert(annotation: PrototypeAnnotation): void;
  window: Window;
}

export interface PrototypeAnnotationOverlay {
  clear(): void;
  destroy(): void;
  setActive(active: boolean): void;
  toggle(): void;
}

export function createPrototypeAnnotationOverlay({
  document,
  onDelete,
  onUpsert,
  window
}: PrototypeAnnotationOverlayOptions): PrototypeAnnotationOverlay {
  const root = document.createElement('div');
  root.dataset.projectSpaceAnnotationOverlay = 'true';
  setStyles(root, {
    inset: '0',
    pointerEvents: 'none',
    position: 'fixed',
    zIndex: '2147483647'
  });

  const highlight = document.createElement('div');
  setStyles(highlight, {
    background: 'rgb(251 191 36 / 12%)',
    border: '2px solid rgb(251 191 36)',
    borderRadius: '6px',
    boxShadow: '0 0 0 1px rgb(0 0 0 / 45%)',
    display: 'none',
    pointerEvents: 'none',
    position: 'fixed',
    transition: 'height 80ms ease, left 80ms ease, top 80ms ease, width 80ms ease'
  });

  const modeHud = document.createElement('div');
  setStyles(modeHud, {
    alignItems: 'center',
    background: 'rgb(18 18 18 / 94%)',
    border: '1px solid rgb(255 255 255 / 12%)',
    borderRadius: '999px',
    boxShadow: '0 12px 36px rgb(0 0 0 / 35%)',
    color: '#f5f5f5',
    display: 'none',
    font: '500 12px/1 system-ui, sans-serif',
    gap: '10px',
    left: '50%',
    padding: '8px 10px 8px 13px',
    pointerEvents: 'auto',
    position: 'fixed',
    top: '12px',
    transform: 'translateX(-50%)',
    whiteSpace: 'nowrap'
  });
  const modeLabel = document.createElement('span');
  modeLabel.textContent = 'Select an element to comment';
  const finishButton = actionButton(document, 'Done');
  modeHud.append(modeLabel, finishButton);
  root.append(highlight, modeHud);
  document.body.append(root);

  const entries = new Map<string, AnnotationEntry>();
  let active = false;
  let currentTarget: Element | undefined;
  let editor: HTMLElement | undefined;
  let previousCursor = '';

  const onPointerMove = (event: PointerEvent) => {
    if (!active || editor) return;
    const target = selectableTarget(event.target, root);
    currentTarget = target;
    if (target) positionRect(highlight, target.getBoundingClientRect());
    else highlight.style.display = 'none';
  };
  const onClick = (event: MouseEvent) => {
    if (!active || root.contains(event.target as Node)) return;
    const target = selectableTarget(event.target, root);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openEditor(target);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !active) return;
    event.preventDefault();
    if (editor) closeEditor();
    else setActive(false);
  };
  const refresh = () => {
    if (currentTarget && active && !editor) {
      positionRect(highlight, currentTarget.getBoundingClientRect());
    }
    for (const entry of entries.values()) positionMarker(entry);
  };

  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', refresh);
  window.addEventListener('scroll', refresh, true);
  finishButton.addEventListener('click', () => setActive(false));

  function openEditor(target: Element, existing?: AnnotationEntry) {
    closeEditor();
    currentTarget = target;
    const rect = target.getBoundingClientRect();
    const form = document.createElement('form');
    form.setAttribute('aria-label', 'Prototype element comment');
    setStyles(form, {
      background: 'rgb(18 18 18 / 97%)',
      border: '1px solid rgb(255 255 255 / 14%)',
      borderRadius: '16px',
      boxShadow: '0 18px 58px rgb(0 0 0 / 45%)',
      color: '#f5f5f5',
      display: 'grid',
      gap: '10px',
      maxWidth: 'calc(100vw - 24px)',
      padding: '12px',
      pointerEvents: 'auto',
      position: 'fixed',
      width: '320px'
    });

    const title = document.createElement('strong');
    setStyles(title, {
      font: '600 12px/1.35 system-ui, sans-serif',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    });
    title.textContent = elementLabel(target);

    const input = document.createElement('textarea');
    input.setAttribute('aria-label', 'Comment');
    input.placeholder = 'What should change?';
    input.rows = 3;
    input.value = existing?.annotation.comment ?? '';
    setStyles(input, {
      background: '#27272a',
      border: '0',
      borderRadius: '10px',
      color: '#f5f5f5',
      font: '400 13px/1.5 system-ui, sans-serif',
      maxHeight: '140px',
      minHeight: '72px',
      outline: 'none',
      padding: '10px',
      resize: 'vertical',
      width: '100%'
    });

    const actions = document.createElement('div');
    setStyles(actions, {
      alignItems: 'center',
      display: 'flex',
      gap: '8px',
      justifyContent: 'flex-end'
    });
    if (existing) {
      const deleteButton = actionButton(document, 'Delete', true);
      deleteButton.addEventListener('click', () => {
        entries.delete(existing.annotation.id);
        existing.marker.remove();
        onDelete(existing.annotation);
        closeEditor();
      });
      actions.append(deleteButton);
    }
    const cancelButton = actionButton(document, 'Cancel');
    cancelButton.addEventListener('click', closeEditor);
    const saveButton = actionButton(document, existing ? 'Save' : 'Add', false, true);
    actions.append(cancelButton, saveButton);
    form.append(title, input, actions);
    root.append(form);
    editor = form;
    positionEditor(form, rect, window);
    input.focus();

    const save = () => {
      const comment = input.value.trim();
      if (!comment) {
        input.focus();
        return;
      }
      const annotation = annotationFor(target, comment, existing?.annotation.id);
      if (!annotation) return;
      upsertEntry(target, annotation, existing);
      onUpsert(annotation);
      closeEditor();
    };
    saveButton.addEventListener('click', (event) => {
      event.preventDefault();
      save();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      save();
    });
  }

  function upsertEntry(
    target: Element,
    annotation: PrototypeAnnotation,
    existing?: AnnotationEntry
  ) {
    const marker = existing?.marker ?? document.createElement('button');
    marker.type = 'button';
    marker.setAttribute('aria-label', `Edit comment for ${annotation.element}`);
    marker.textContent = String(entries.size + (existing ? 0 : 1));
    setStyles(marker, {
      alignItems: 'center',
      background: '#fbbf24',
      border: '2px solid #18181b',
      borderRadius: '999px',
      boxShadow: '0 5px 18px rgb(0 0 0 / 35%)',
      color: '#18181b',
      display: 'flex',
      font: '700 11px/1 system-ui, sans-serif',
      height: '24px',
      justifyContent: 'center',
      pointerEvents: 'auto',
      position: 'fixed',
      width: '24px'
    });
    const entry = { annotation, marker, target };
    entries.set(annotation.id, entry);
    if (!existing) {
      marker.addEventListener('click', () => openEditor(entry.target, entry));
      root.append(marker);
    }
    positionMarker(entry);
  }

  function positionMarker(entry: AnnotationEntry) {
    const rect = entry.target.getBoundingClientRect();
    entry.marker.style.left = `${Math.max(4, Math.min(window.innerWidth - 28, rect.right - 12))}px`;
    entry.marker.style.top = `${Math.max(4, Math.min(window.innerHeight - 28, rect.top - 12))}px`;
  }

  function closeEditor() {
    editor?.remove();
    editor = undefined;
    if (active && currentTarget) {
      positionRect(highlight, currentTarget.getBoundingClientRect());
    }
  }

  function clear() {
    closeEditor();
    for (const entry of entries.values()) entry.marker.remove();
    entries.clear();
  }

  function setActive(next: boolean) {
    if (active === next) return;
    active = next;
    closeEditor();
    currentTarget = undefined;
    highlight.style.display = 'none';
    modeHud.style.display = active ? 'flex' : 'none';
    if (active) {
      previousCursor = document.body.style.cursor;
      document.body.style.cursor = 'crosshair';
    } else {
      document.body.style.cursor = previousCursor;
    }
  }

  return {
    clear,
    destroy() {
      setActive(false);
      clear();
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
      root.remove();
    },
    setActive,
    toggle() {
      setActive(!active);
    }
  };
}

function annotationFor(
  target: Element,
  comment: string,
  existingId?: string
): PrototypeAnnotation | undefined {
  const rect = target.getBoundingClientRect();
  const elementPath = elementSelector(target);
  if (!elementPath) return undefined;
  const ariaLabel = target.getAttribute('aria-label')?.trim();
  const role = target.getAttribute('role')?.trim();
  const parentText = target.parentElement?.textContent?.replace(/\s+/g, ' ').trim();
  const sourceFile = closestAttribute(target, 'data-source-file');
  return {
    id: existingId ?? `prototype-comment-${Date.now()}-${nextAnnotationId++}`,
    comment,
    element: elementLabel(target),
    elementPath,
    boundingBox: {
      height: rect.height,
      width: rect.width,
      x: rect.x,
      y: rect.y
    },
    ...(ariaLabel || role
      ? { accessibility: [role ? `role=${role}` : '', ariaLabel ? `aria-label=${ariaLabel}` : '']
          .filter(Boolean)
          .join(', ') }
      : {}),
    ...(target.className && typeof target.className === 'string'
      ? { cssClasses: target.className }
      : {}),
    ...(parentText ? { nearbyText: parentText.slice(0, 2_000) } : {}),
    ...(window.getSelection()?.toString().trim()
      ? { selectedText: window.getSelection()!.toString().trim().slice(0, 2_000) }
      : {}),
    ...(sourceFile ? { sourceFile } : {})
  };
}

let nextAnnotationId = 1;

function selectableTarget(value: EventTarget | null, root: HTMLElement) {
  if (!(value instanceof Element) || root.contains(value)) return undefined;
  if (value === document.documentElement || value === document.body) return undefined;
  return value;
}

function elementLabel(element: Element) {
  const aria = element.getAttribute('aria-label')?.trim();
  if (aria) return aria.slice(0, 240);
  const text = element.textContent?.replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 80);
  return element.tagName.toLowerCase();
}

function elementSelector(element: Element) {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && parts.length < 10) {
    const id = current.getAttribute('id');
    if (id) {
      parts.unshift(`#${cssEscape(id)}`);
      break;
    }
    const testId = current.getAttribute('data-testid');
    if (testId) {
      parts.unshift(`[data-testid="${cssEscape(testId)}"]`);
      break;
    }
    let part = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (parent) {
      const peers = Array.from(parent.children).filter(
        (child) => child.tagName === current!.tagName
      );
      if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(' > ');
}

function closestAttribute(element: Element, attribute: string) {
  let current: Element | null = element;
  while (current) {
    const value = current.getAttribute(attribute)?.trim();
    if (value) return value.slice(0, 600);
    current = current.parentElement;
  }
  return undefined;
}

function cssEscape(value: string) {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(value)
    : value.replace(/["\\#.:,[\]()]/g, '\\$&');
}

function positionRect(element: HTMLElement, rect: DOMRect) {
  element.style.display = 'block';
  element.style.height = `${Math.max(0, rect.height)}px`;
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  element.style.width = `${Math.max(0, rect.width)}px`;
}

function positionEditor(element: HTMLElement, rect: DOMRect, window: Window) {
  const width = Math.min(320, window.innerWidth - 24);
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left));
  const top = rect.bottom + 12 + 180 <= window.innerHeight
    ? rect.bottom + 12
    : Math.max(12, rect.top - 192);
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.width = `${width}px`;
}

function actionButton(
  document: Document,
  label: string,
  danger = false,
  primary = false
) {
  const button = document.createElement('button');
  button.type = primary ? 'submit' : 'button';
  button.textContent = label;
  setStyles(button, {
    background: primary ? '#f5f5f5' : danger ? 'rgb(244 63 94 / 14%)' : '#27272a',
    border: '0',
    borderRadius: '9px',
    color: primary ? '#18181b' : danger ? '#fb7185' : '#d4d4d8',
    cursor: 'pointer',
    font: '600 12px/1 system-ui, sans-serif',
    padding: '9px 12px'
  });
  return button;
}

function setStyles(element: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
  Object.assign(element.style, styles);
}
