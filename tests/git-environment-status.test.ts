import { describe, expect, test } from 'bun:test';
import { commitsBehindRef, correlateEnvironments } from '../src/features/project-desktop/components/git-environment-correlation';

const commit = (hash: string) => ({ author: '', date: '', hash, parents: [], refs: [], subject: '' });
const environment = (id: string, deployedSha: string, verification: 'healthy' | 'unhealthy' | 'inconsistent' = 'healthy') => ({
  deployedSha, displayName: id, id, verification
});

describe('git environment correlation', () => {
  test('matches only full SHAs and supports multiple environments on one commit', () => {
    const sha = '1'.repeat(40);
    const result = correlateEnvironments([commit(sha)], [environment('prod', sha), environment('beta', sha)]);
    expect(result.byCommit.get(sha)?.map((entry) => entry.id)).toEqual(['prod', 'beta']);
    expect(result.byCommit.has(`${sha.slice(0, 39)}2`)).toBe(false);
  });

  test('keeps dev-only commits and outside-history deployments honest', () => {
    const devSha = '2'.repeat(40);
    const outsideSha = '3'.repeat(40);
    const result = correlateEnvironments([commit(devSha)], [environment('dev', devSha), environment('future', outsideSha), environment('bad', devSha, 'unhealthy')]);
    expect(result.byCommit.get(devSha)?.map((entry) => entry.id)).toEqual(['dev', 'bad']);
    expect(result.outsideHistory.map((entry) => entry.id)).toEqual(['future']);
  });

  test('computes reliable branch lag and leaves unrelated history unknown', () => {
    const deployed = '4'.repeat(40), middle = '5'.repeat(40), tip = '6'.repeat(40);
    const history = [
      { ...commit(tip), parents: [middle] },
      { ...commit(middle), parents: [deployed] },
      commit(deployed)
    ];
    expect(commitsBehindRef(history, deployed, tip)).toBe(2);
    expect(commitsBehindRef(history, '7'.repeat(40), tip)).toBeUndefined();
  });
});
