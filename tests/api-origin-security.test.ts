import type { ServerResponse } from 'node:http';

import { describe, expect, test } from 'bun:test';

import {
  isProjectSpaceApiRequestAllowed,
  resolveProjectSpaceApiBaseUrl
} from '../src/api/project-space-client';
import {
  projectSpaceCorsHeaders,
  writeText
} from '../server/project-space-http-response';

describe('Project Space API origin policy', () => {
  test('keeps hosted pages same-origin even when URL or build settings request another API', () => {
    expect(
      resolveProjectSpaceApiBaseUrl(
        'https://projects.os-home.net/?projectSpaceApi=https://attacker.example',
        'https://api.attacker.example'
      )
    ).toBe('');
    expect(
      resolveProjectSpaceApiBaseUrl(
        'https://projects.os-home.net/?projectSpaceApi=http://127.0.0.1:45873',
        'http://localhost:45873'
      )
    ).toBe('');
  });

  test('allows only plain loopback origins from a loopback page', () => {
    expect(
      resolveProjectSpaceApiBaseUrl(
        'http://127.0.0.1:5173/?projectSpaceApi=http://localhost:45873/'
      )
    ).toBe('http://localhost:45873');
    expect(
      resolveProjectSpaceApiBaseUrl(
        'http://localhost:5173/?projectSpaceApi=https://attacker.example'
      )
    ).toBe('');
    expect(
      resolveProjectSpaceApiBaseUrl(
        'http://localhost:5173/?projectSpaceApi=http://localhost:45873/api'
      )
    ).toBe('');
    expect(
      resolveProjectSpaceApiBaseUrl(
        'http://localhost:5173/?projectSpaceApi=http://user:pass@localhost:45873/'
      )
    ).toBe('');
  });

  test('never authorizes bearer requests to arbitrary origins', () => {
    expect(
      isProjectSpaceApiRequestAllowed(
        'https://projects.os-home.net/projects',
        'https://projects.os-home.net/api/projects/discovery'
      )
    ).toBe(true);
    expect(
      isProjectSpaceApiRequestAllowed(
        'http://127.0.0.1:5173/',
        'http://localhost:45873/api/projects/discovery'
      )
    ).toBe(true);
    expect(
      isProjectSpaceApiRequestAllowed(
        'https://projects.os-home.net/',
        'https://attacker.example/api/projects/discovery'
      )
    ).toBe(false);
    expect(
      isProjectSpaceApiRequestAllowed(
        'http://localhost:5173/',
        'http://user:pass@localhost:45873/api/projects/discovery'
      )
    ).toBe(false);
  });
});

describe('Project Space CORS policy', () => {
  test('does not emit CORS headers in production', () => {
    expect(
      projectSpaceCorsHeaders({
        NODE_ENV: 'production',
        PROJECT_SPACE_DEV_CORS_ORIGIN: 'http://127.0.0.1:5173'
      })
    ).toEqual({});
  });

  test('allows one explicitly configured loopback development origin', () => {
    expect(
      projectSpaceCorsHeaders({
        NODE_ENV: 'development',
        PROJECT_SPACE_DEV_CORS_ORIGIN: 'http://127.0.0.1:5173/'
      })
    ).toEqual({
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,OPTIONS',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Allow-Origin': 'http://127.0.0.1:5173',
      Vary: 'Origin'
    });
  });

  test('rejects non-loopback and malformed development origins', () => {
    expect(
      projectSpaceCorsHeaders({
        NODE_ENV: 'development',
        PROJECT_SPACE_DEV_CORS_ORIGIN: 'https://attacker.example'
      })
    ).toEqual({});
    expect(
      projectSpaceCorsHeaders({
        NODE_ENV: 'development',
        PROJECT_SPACE_DEV_CORS_ORIGIN: 'http://localhost:5173/not-an-origin'
      })
    ).toEqual({});
  });

  test('still writes the public connector install script response without wildcard CORS', () => {
    let statusCode = 0;
    let headers: Record<string, string> = {};
    let body = '';
    const response = {
      end(value?: string) {
        body = value ?? '';
      },
      writeHead(code: number, value: Record<string, string>) {
        statusCode = code;
        headers = value;
      }
    } as unknown as ServerResponse;

    writeText(response, 200, '#!/usr/bin/env bash\necho ready\n', 'text/x-shellscript');

    expect(statusCode).toBe(200);
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Content-Type']).toBe('text/x-shellscript');
    expect(body).toContain('#!/usr/bin/env bash');
  });
});
