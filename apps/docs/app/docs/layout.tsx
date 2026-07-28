import { source } from '@/lib/source';
import { DocsDeploymentFooter } from '@/components/docs-deployment-footer';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      sidebar={{ footer: <DocsDeploymentFooter /> }}
      {...baseOptions()}
    >
      {children}
    </DocsLayout>
  );
}
