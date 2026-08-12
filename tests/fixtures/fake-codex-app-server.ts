#!/usr/bin/env bun

import { createInterface } from 'node:readline';

const input = createInterface({ crlfDelay: Infinity, input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line) as { id?: number; method?: string };
  if (request.id === undefined) return;
  const result = request.method === 'thread/loaded/list' ? { data: [] } : {};
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
});
