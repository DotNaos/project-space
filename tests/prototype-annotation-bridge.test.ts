import { describe, expect, test } from 'bun:test';

import {
  formatPrototypeFeedback,
  parsePrototypeAnnotationCommand,
  parsePrototypeAnnotationEvent,
  prototypeAnnotationBridgeSource,
  prototypeAnnotationCommand,
  prototypeAnnotationEvent,
  sanitizePrototypeAnnotation
} from '../src/shared/prototype-annotation-bridge';

const annotation = {
  boundingBox: { height: 40, width: 120, x: 10, y: 20 },
  comment: 'Increase the spacing',
  element: 'Save button',
  elementPath: 'main > form > button',
  id: 'annotation-1',
  nearbyText: 'Save changes',
  sourceFile: 'src/save-button.tsx'
};

describe('prototype annotation bridge', () => {
  test('accepts only narrow commands with the exact bridge source', () => {
    expect(parsePrototypeAnnotationCommand(prototypeAnnotationCommand('enable'))).toEqual({
      action: 'enable',
      source: prototypeAnnotationBridgeSource
    });
    expect(parsePrototypeAnnotationCommand(prototypeAnnotationCommand('disable'))).toEqual({
      action: 'disable',
      source: prototypeAnnotationBridgeSource
    });
    expect(parsePrototypeAnnotationCommand({
      action: 'toggle',
      source: 'untrusted'
    })).toBeUndefined();
    expect(parsePrototypeAnnotationCommand({
      action: 'terminal',
      source: prototypeAnnotationBridgeSource
    })).toBeUndefined();
  });

  test('sanitizes bounded annotation fields and rejects incomplete data', () => {
    expect(sanitizePrototypeAnnotation({
      ...annotation,
      comment: `  ${'x'.repeat(5_000)}  `,
      token: 'must-not-cross-the-bridge'
    })).toEqual({
      ...annotation,
      comment: 'x'.repeat(4_000)
    });
    expect(sanitizePrototypeAnnotation({ ...annotation, comment: ' ' })).toBeUndefined();
  });

  test('parses annotation events without accepting extra capabilities', () => {
    const event = prototypeAnnotationEvent('upsert', annotation);
    expect(parsePrototypeAnnotationEvent(event)).toEqual(event);
    expect(parsePrototypeAnnotationEvent({
      action: 'upsert',
      annotation: { ...annotation, comment: '' },
      source: prototypeAnnotationBridgeSource
    })).toBeUndefined();
    expect(parsePrototypeAnnotationEvent({
      action: 'ready',
      machineId: 'must-not-be-consumed',
      source: prototypeAnnotationBridgeSource
    })).toEqual({
      action: 'ready',
      source: prototypeAnnotationBridgeSource
    });
  });

  test('formats annotations with an optional composer message', () => {
    expect(formatPrototypeFeedback('Please polish this flow.', [annotation])).toContain(
      [
        'Please polish this flow.',
        '',
        'Prototype annotations:',
        '',
        '1. Save button — Increase the spacing',
        '   Element: main > form > button',
        '   Source: src/save-button.tsx',
        '   Nearby text: Save changes'
      ].join('\n')
    );
    expect(formatPrototypeFeedback('', [annotation])).toStartWith('Prototype annotations:');
    expect(formatPrototypeFeedback('  ', [])).toBe('');
  });
});
