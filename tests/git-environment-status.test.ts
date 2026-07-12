import { describe, expect, test } from 'bun:test';
import { commitsBehindRef, correlateEnvironments } from '../src/features/project-desktop/components/git-environment-correlation';

const commit = (hash: string) => ({ author: '', date: '', hash, parents: [], refs: [], subject: '' });
const environment = (id: string, deployedSha: string, verification: 'healthy' | 'unhealthy' | 'inconsistent' = 'healthy') => ({
  deployedSha, displayName: id, id, liveUrlState: 'not-configured' as const, verification
});

describe('git environment correlation', () => {
  test('matches only full SHAs and supports multiple environments on one commit', () => {
    const sha = '1'.repeat(40);
    const result = correlateEnvironments([commit(sha)], [environment('prod', sha), environment('beta', sha)]);
    expect(result.byCommit.get(sha)?.map((entry) => entry.id)).toEqual(['prod', 'beta']);
    expect(result.byCommit.has(`${sha.slice(0, 39)}2`)).toBe(false);
    expect(correlateEnvironments([commit('abc1234')], [environment('short', 'abc1234')]).byCommit.size).toBe(0);
    expect(correlateEnvironments([commit('z'.repeat(40))], [environment('invalid', 'z'.repeat(40))]).byCommit.size).toBe(0);
  });

  test('retains every public URL only on the exact matching commit', () => {
    const sha = 'a'.repeat(40);
    const prod = { ...environment('prod', sha), liveUrl: 'https://prod.example.com', liveUrlState: 'available' as const };
    const dev = { ...environment('dev', sha), liveUrl: 'https://dev.example.com', liveUrlState: 'available' as const };
    const result = correlateEnvironments([commit(sha)], [prod, dev]);
    expect(result.byCommit.get(sha)?.map((entry) => entry.liveUrl)).toEqual([
      'https://prod.example.com',
      'https://dev.example.com'
    ]);
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
