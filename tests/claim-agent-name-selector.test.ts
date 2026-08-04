import { expect, test } from 'bun:test';

test('the versioned startup selector passes lease, reconciliation, and concurrency checks',()=>{
  const result=Bun.spawnSync([
    'python3','-m','unittest','discover','-s','tools/claim-agent-name','-p','test_*.py'
  ],{
    cwd:process.cwd(),
    stderr:'pipe',
    stdout:'pipe'
  });
  expect(new TextDecoder().decode(result.stderr)).toContain('OK');
  expect(result.exitCode).toBe(0);
},30_000);
