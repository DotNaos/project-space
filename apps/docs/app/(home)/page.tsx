import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col justify-center px-6 py-24 text-center">
      <h1 className="mb-4 text-3xl font-semibold tracking-tight">Project Documentation</h1>
      <p className="mx-auto mb-8 max-w-2xl text-fd-muted-foreground">
        CLI, API, and internal logic for creating, validating, updating, and deploying template-backed projects.
      </p>
      <Link
        href="/docs/project"
        className="mx-auto rounded-md bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
      >
        Open docs
      </Link>
    </main>
  );
}
