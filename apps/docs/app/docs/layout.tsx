import { source } from '@/lib/source';
import { DocsDeploymentFooter } from '@/components/docs-deployment-footer';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { releaseCatalogResult } from '@/lib/releases/source';
import { withReleaseNavigation } from '@/lib/releases/navigation';
import { ReleaseSidebarItem } from '@/components/release-sidebar-item';
import { ReleaseSidebarFolder } from '@/components/release-sidebar-folder';
import { DocsDeploymentIdentityProvider } from '@/components/docs-article-identity';
import { headers } from 'next/headers';

export default async function Layout({ children }: LayoutProps<'/docs'>) {
  const entries = releaseCatalogResult.ok
    ? releaseCatalogResult.catalog.entries
    : [];
  const requestHeaders = await headers();
  const previewPullRequest =
    previewPullRequestFromHost(
      requestHeaders.get('x-forwarded-host') ??
        requestHeaders.get('host') ??
        '',
    ) ??
    positiveInteger(
      process.env.PROJECT_SPACE_PREVIEW_PR_NUMBER,
    );

  return (
    <DocsLayout
      tree={withReleaseNavigation(source.getPageTree(), entries, {
        previewPullRequest,
      })}
      sidebar={{
        components: {
          Folder: ReleaseSidebarFolder,
          Item: ReleaseSidebarItem,
        },
        footer: <DocsDeploymentFooter key="deployment-identity" />,
      }}
      {...baseOptions()}
    >
      <DocsDeploymentIdentityProvider>
        {children}
      </DocsDeploymentIdentityProvider>
    </DocsLayout>
  );
}

function positiveInteger(value: string | undefined) {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function previewPullRequestFromHost(value: string) {
  const hostname = value
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
  const match =
    /^pr-([1-9]\d*)\.projects\.os-home\.net$/.exec(hostname);
  return positiveInteger(match?.[1]);
}
