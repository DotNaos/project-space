import { describe, expect, test } from 'bun:test';
import { createBrowserRandomUuid } from '../src/shared/browser-random-uuid';

describe('createBrowserRandomUuid', () => {
  test('uses randomUUID when the browser exposes it', () => {
    const expected = '11111111-2222-4333-8444-555555555555';
    const source = {
      randomUUID: () => expected
    } as Crypto;

    expect(createBrowserRandomUuid(source)).toBe(expected);
  });

  test('creates a standards-compliant UUID with getRandomValues on an HTTP origin', () => {
    const source = {
      getRandomValues(array: Uint8Array) {
        array.forEach((_, index) => { array[index] = index; });
        return array;
      }
    } as unknown as Crypto;

    const uuid = createBrowserRandomUuid(source);

    expect(uuid).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('fails locally when no secure browser randomness exists', () => {
    expect(() => createBrowserRandomUuid(null)).toThrow(
      'This browser cannot create a secure operation identifier.'
    );
  });
});
