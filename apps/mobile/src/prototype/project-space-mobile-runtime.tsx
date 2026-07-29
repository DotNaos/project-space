import { ProjectOverviewScreen } from '../features/overview/components/project-overview-screen';
import { useProjectInventory } from '../hooks/use-project-inventory';
import { osAuthClient } from '../services/os-auth-client';

export function ProjectSpaceMobileRuntime() {
  const projectInventory = useProjectInventory();
  const osSession = osAuthClient.useSession();
  const accountLabel = osSession.isPending
    ? 'Checking OS account'
    : osSession.data?.user?.email ?? 'Signed out of OS account';

  return (
    <ProjectOverviewScreen
      accountLabel={accountLabel}
      errorMessage={projectInventory.errorMessage}
      inventory={projectInventory.inventory}
      isRefreshing={projectInventory.isRefreshing}
      onRefresh={projectInventory.refresh}
      sourceLabel={projectInventory.sourceLabel}
    />
  );
}
