import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const mobileRoot = fileURLToPath(new URL('../apps/mobile', import.meta.url));

export function shouldBuildMobilePrototype(
  environment: Record<string, string | undefined>
) {
  return !(
    environment.PROJECT_SPACE_BUILD_COMMIT &&
    environment.VITE_CLERK_PUBLISHABLE_KEY
  );
}

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, {
    cwd,
    env: process.env,
    stderr: 'inherit',
    stdout: 'inherit'
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

if (import.meta.main) {
  run(['bun', 'run', 'build:web'], projectRoot);

  if (!shouldBuildMobilePrototype(process.env)) {
    console.log(
      'Mobile prototype build is provided by the separate trusted Preview image.'
    );
    process.exit(0);
  }

  run(
    ['bun', 'install', '--frozen-lockfile'],
    mobileRoot
  );
  run(['bun', 'run', 'build:prototype'], mobileRoot);
}
