export const prototypeAnnotationBridgeSource =
  'project-space.prototype-annotations.v1';

export interface PrototypeAnnotation {
  accessibility?: string;
  boundingBox?: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  comment: string;
  cssClasses?: string;
  element: string;
  elementPath: string;
  id: string;
  nearbyText?: string;
  selectedText?: string;
  sourceFile?: string;
}

export type PrototypeAnnotationCommand =
  | { action: 'clear'; source: typeof prototypeAnnotationBridgeSource }
  | { action: 'disable'; source: typeof prototypeAnnotationBridgeSource }
  | { action: 'enable'; source: typeof prototypeAnnotationBridgeSource }
  | { action: 'toggle'; source: typeof prototypeAnnotationBridgeSource };

export type PrototypeAnnotationEvent =
  | {
      action: 'delete';
      annotationId: string;
      source: typeof prototypeAnnotationBridgeSource;
    }
  | {
      action: 'clear';
      source: typeof prototypeAnnotationBridgeSource;
    }
  | {
      action: 'ready';
      source: typeof prototypeAnnotationBridgeSource;
    }
  | {
      action: 'upsert';
      annotation: PrototypeAnnotation;
      source: typeof prototypeAnnotationBridgeSource;
    };

const stringLimits = {
  accessibility: 1_500,
  comment: 4_000,
  cssClasses: 1_500,
  element: 240,
  elementPath: 1_500,
  id: 160,
  nearbyText: 2_000,
  selectedText: 2_000,
  sourceFile: 600
} as const;

export function prototypeAnnotationCommand(
  action: PrototypeAnnotationCommand['action']
): PrototypeAnnotationCommand {
  return { action, source: prototypeAnnotationBridgeSource };
}

export function parsePrototypeAnnotationCommand(
  value: unknown
): PrototypeAnnotationCommand | undefined {
  if (!isRecord(value) || value.source !== prototypeAnnotationBridgeSource) {
    return undefined;
  }
  return value.action === 'clear' ||
    value.action === 'disable' ||
    value.action === 'enable' ||
    value.action === 'toggle'
    ? { action: value.action, source: prototypeAnnotationBridgeSource }
    : undefined;
}

export function parsePrototypeAnnotationEvent(
  value: unknown
): PrototypeAnnotationEvent | undefined {
  if (!isRecord(value) || value.source !== prototypeAnnotationBridgeSource) {
    return undefined;
  }
  if (value.action === 'clear') {
    return { action: 'clear', source: prototypeAnnotationBridgeSource };
  }
  if (value.action === 'ready') {
    return { action: 'ready', source: prototypeAnnotationBridgeSource };
  }
  if (value.action === 'delete') {
    const annotationId = cleanString(value.annotationId, stringLimits.id);
    return annotationId
      ? { action: 'delete', annotationId, source: prototypeAnnotationBridgeSource }
      : undefined;
  }
  if (value.action === 'upsert') {
    const annotation = sanitizePrototypeAnnotation(value.annotation);
    return annotation
      ? { action: 'upsert', annotation, source: prototypeAnnotationBridgeSource }
      : undefined;
  }
  return undefined;
}

export function prototypeAnnotationEvent(
  action: 'clear' | 'ready'
): PrototypeAnnotationEvent;
export function prototypeAnnotationEvent(
  action: 'delete',
  value: { id: string }
): PrototypeAnnotationEvent | undefined;
export function prototypeAnnotationEvent(
  action: 'upsert',
  value: unknown
): PrototypeAnnotationEvent | undefined;
export function prototypeAnnotationEvent(
  action: PrototypeAnnotationEvent['action'],
  value?: unknown
): PrototypeAnnotationEvent | undefined {
  if (action === 'clear' || action === 'ready') {
    return { action, source: prototypeAnnotationBridgeSource };
  }
  if (action === 'delete') {
    const id = isRecord(value) ? cleanString(value.id, stringLimits.id) : undefined;
    return id
      ? { action, annotationId: id, source: prototypeAnnotationBridgeSource }
      : undefined;
  }
  const annotation = sanitizePrototypeAnnotation(value);
  return annotation
    ? { action, annotation, source: prototypeAnnotationBridgeSource }
    : undefined;
}

export function sanitizePrototypeAnnotation(
  value: unknown
): PrototypeAnnotation | undefined {
  if (!isRecord(value)) return undefined;
  const id = cleanString(value.id, stringLimits.id);
  const comment = cleanString(value.comment, stringLimits.comment);
  const element = cleanString(value.element, stringLimits.element);
  const elementPath = cleanString(value.elementPath, stringLimits.elementPath);
  if (!id || !comment || !element || !elementPath) return undefined;

  const boundingBox = cleanBoundingBox(value.boundingBox);
  return {
    id,
    comment,
    element,
    elementPath,
    ...(boundingBox ? { boundingBox } : {}),
    ...optionalString(value, 'accessibility'),
    ...optionalString(value, 'cssClasses'),
    ...optionalString(value, 'nearbyText'),
    ...optionalString(value, 'selectedText'),
    ...optionalString(value, 'sourceFile')
  };
}

export function formatPrototypeFeedback(
  comment: string,
  annotations: readonly PrototypeAnnotation[]
) {
  const sections: string[] = [];
  const cleanComment = comment.trim();
  if (cleanComment) sections.push(cleanComment);
  if (annotations.length) {
    sections.push([
      'Prototype annotations:',
      ...annotations.slice(0, 100).flatMap((annotation, index) => [
        '',
        `${index + 1}. ${annotation.element} — ${annotation.comment}`,
        `   Element: ${annotation.elementPath}`,
        ...(annotation.sourceFile ? [`   Source: ${annotation.sourceFile}`] : []),
        ...(annotation.selectedText ? [`   Selected text: ${annotation.selectedText}`] : []),
        ...(annotation.nearbyText ? [`   Nearby text: ${annotation.nearbyText}`] : [])
      ])
    ].join('\n'));
  }
  return sections.join('\n\n');
}

function optionalString(
  value: Record<string, unknown>,
  key: keyof typeof stringLimits
) {
  const clean = cleanString(value[key], stringLimits[key]);
  return clean ? { [key]: clean } : {};
}

function cleanBoundingBox(value: unknown) {
  if (!isRecord(value)) return undefined;
  const x = cleanNumber(value.x);
  const y = cleanNumber(value.y);
  const width = cleanNumber(value.width);
  const height = cleanNumber(value.height);
  return x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
    ? undefined
    : { height, width, x, y };
}

function cleanNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-100_000, Math.min(100_000, value))
    : undefined;
}

function cleanString(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
