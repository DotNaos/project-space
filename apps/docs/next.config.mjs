import { createMDX } from 'fumadocs-mdx/next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = withMDX({
  reactStrictMode: true,
});

export default function projectSpaceDocsConfig(phase) {
  if (
    phase === PHASE_DEVELOPMENT_SERVER &&
    process.env.PROJECT_SPACE_MANAGED_SERVE !== '1'
  ) {
    throw new Error(
      'Project Space docs dev servers are managed by the Project CLI. Use `project serve docs`, or add `--local-only` for the explicit local fallback.',
    );
  }
  return config;
}
