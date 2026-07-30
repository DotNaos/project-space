import { loadGithubPublication } from '@/lib/releases/github-publication';
import { parseStableSemver } from '@/lib/releases/semver';
import { NextResponse } from 'next/server';

export async function GET(
  _request: Request,
  context: RouteContext<'/docs/api/releases/[version]'>,
) {
  const { version } = await context.params;
  if (!parseStableSemver(version)) {
    return NextResponse.json(
      { error: 'A stable release version is required.' },
      { status: 400 },
    );
  }

  try {
    const publication = await loadGithubPublication(version);
    return NextResponse.json(publication, {
      headers: {
        'cache-control':
          'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: `Verified publication metadata for v${version} is unavailable.`,
      },
      { status: 404 },
    );
  }
}
