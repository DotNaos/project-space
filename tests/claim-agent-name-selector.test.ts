import { expect, test } from 'bun:test';

test('the versioned startup selector passes lease, reconciliation, and concurrency checks',()=>{
  const result=Bun.spawnSync([
    'python3','-m','unittest','tools/claim-agent-name/test_select_display_name.py'
  ],{
    cwd:process.cwd(),
    stderr:'pipe',
    stdout:'pipe'
  });
  expect(new TextDecoder().decode(result.stderr)).toContain('OK');
  expect(result.exitCode).toBe(0);
},30_000);
