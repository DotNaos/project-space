import { createMDX } from 'fumadocs-mdx/next';

if (
  process.env.NODE_ENV === 'development' &&
  process.env.PROJECT_SPACE_MANAGED_SERVE !== '1'
) {
  throw new Error(
    'Project Space docs dev servers are managed by the Project CLI. Use `project serve docs`, or add `--local-only` for the explicit local fallback.',
  );
}

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
};

export default withMDX(config);
