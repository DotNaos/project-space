import { describe, expect, test } from 'bun:test';
import {
  currentPackageManagerPolicyViolations,
  packageManagerPolicyViolations
} from '../scripts/check-package-manager';

const competingManager = ['p', 'npm'].join('');
const competingLock = `${competingManager}-lock.yaml`;

describe('Bun-only package-manager policy', () => {
  test('accepts the complete current repository policy', () => {
    expect(currentPackageManagerPolicyViolations()).toEqual([]);
  });

  test('rejects competing commands and lockfiles', () => {
    expect(packageManagerPolicyViolations(
      ['tooling.sh', 'nested.sh', 'bare.sh', 'operator.sh', competingLock],
      (path) => {
        if (path === 'tooling.sh') return `${competingManager} install`;
        if (path === 'nested.sh') return `(${['n', 'px'].join('')} tool)`;
        if (path === 'bare.sh') return competingManager;
        if (path === 'operator.sh') return `${competingManager}&&echo ok`;
        return '';
      }
    )).toEqual([
      'tooling.sh: competing package-manager command',
      'nested.sh: competing package-manager command',
      'bare.sh: competing package-manager command',
      'operator.sh: competing package-manager command',
      `${competingLock}: competing package-manager lock or workspace file`
    ]);
  });

  test('allows compatibility identifiers without invoking another manager', () => {
    expect(packageManagerPolicyViolations(
      ['package.json'],
      () => 'build_sha=${npm_package_version}'
    )).toEqual([]);
  });
});
