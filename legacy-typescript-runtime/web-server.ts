import { resolve } from 'node:path';

import { createProjectSpaceServer } from './project-space-http';

const version = '0.2.0';
const command = process.argv[2] ?? 'serve';

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`Project Space Connector ${version}

Usage:
  project-space-connector [serve]
  project-space-connector --version

Environment:
  PROJECT_SPACE_HOST  Host to bind. Defaults to 127.0.0.1.
  PROJECT_SPACE_PORT  Port to bind. Defaults to 4173.

After starting the connector, open:
  https://project-space-mu.vercel.app

For remote browser access from your tailnet, expose it with:
  tailscale serve --bg --yes 4173
`);
  process.exit(0);
}

if (command === '--version' || command === '-v' || command === 'version') {
  console.log(version);
  process.exit(0);
}

if (command !== 'serve') {
  console.error(`Unknown command: ${command}`);
  console.error('Run project-space-connector --help for usage.');
  process.exit(1);
}

const port = Number(process.env.PORT ?? process.env.PROJECT_SPACE_PORT ?? 4173);
const host = process.env.PROJECT_SPACE_HOST ?? '127.0.0.1';
const staticRoot = resolve(process.cwd(), 'dist/renderer');

const server = await createProjectSpaceServer({
  host,
  port,
  staticRoot
});

console.log(`Project Space fullstack server running at ${server.origin}`);
