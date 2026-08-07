import { connectorReleaseSensitivePaths } from './connector-release-paths';

async function main() {
  const paths = (await Bun.stdin.text()).split('\0').filter(Boolean);
  const sensitive = connectorReleaseSensitivePaths(paths);
  if (sensitive.length === 0) return;
  console.error(
    'The app commit changes connector release inputs after the approved release:'
  );
  for (const path of sensitive) console.error(`- ${path}`);
  process.exit(1);
}

if (import.meta.main) await main();
