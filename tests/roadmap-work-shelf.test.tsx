import { describe, expect, test } from 'bun:test';

describe('roadmap work shelf UI', () => {
  test('passes isolated server-render checks', async () => {
    const child = Bun.spawn([
      'bun',
      'test',
      './tests/roadmap-work-shelf.isolated.tsx'
    ], {
      cwd: process.cwd(),
      stderr: 'pipe',
      stdout: 'pipe'
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text()
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(`${stdout}\n${stderr}`).toContain('2 pass');
  });
});
