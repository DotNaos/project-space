import { describe, expect, test } from 'bun:test';

import { nativeReviewConfig } from '../apps/mobile/src/review/native-review-config';

describe('native Expo Go review configuration', () => {
  test('accepts HTTPS and exact local or Tailscale HTTP origins', () => {
    expect(
      nativeReviewConfig({
        EXPO_PUBLIC_PROJECT_SPACE_REVIEW_ORIGIN: 'https://review.example.test/path',
        EXPO_PUBLIC_PROJECT_SPACE_REVIEW_PR: '356',
      })
    ).toEqual({
      origin: 'https://review.example.test',
      pullRequestNumber: 356,
    });
    expect(
      nativeReviewConfig({
        EXPO_PUBLIC_PROJECT_SPACE_REVIEW_ORIGIN:
          'http://os-macbook.tail5bb1d7.ts.net:1355',
        EXPO_PUBLIC_PROJECT_SPACE_REVIEW_PR: '356',
      })
    ).toEqual({
      origin: 'http://os-macbook.tail5bb1d7.ts.net:1355',
      pullRequestNumber: 356,
    });
    expect(
      nativeReviewConfig({
        EXPO_PUBLIC_PROJECT_SPACE_REVIEW_ORIGIN: 'http://100.64.12.8:1355',
        EXPO_PUBLIC_PROJECT_SPACE_REVIEW_PR: '356',
      })
    ).toBeDefined();
  });

  test('rejects malformed identity and insecure public HTTP', () => {
    expect(
      nativeReviewConfig({
        EXPO_PUBLIC_PROJECT_SPACE_REVIEW_ORIGIN: 'http://example.test',
        EXPO_PUBLIC_PROJECT_SPACE_REVIEW_PR: '356',
      })
    ).toBeUndefined();
    expect(
      nativeReviewConfig({
        EXPO_PUBLIC_PROJECT_SPACE_REVIEW_ORIGIN:
          'http://os-macbook.tail5bb1d7.ts.net.example.test',
        EXPO_PUBLIC_PROJECT_SPACE_REVIEW_PR: '356',
      })
    ).toBeUndefined();
    expect(
      nativeReviewConfig({
        EXPO_PUBLIC_PROJECT_SPACE_REVIEW_ORIGIN: 'not a URL',
        EXPO_PUBLIC_PROJECT_SPACE_REVIEW_PR: '0',
      })
    ).toBeUndefined();
  });
});
