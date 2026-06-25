import './global.css';

import { HeroUINativeProvider } from 'heroui-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ProjectOverviewScreen } from './src/features/overview/components/project-overview-screen';
import { useProjectInventory } from './src/hooks/use-project-inventory';
import { osAuthClient } from './src/services/os-auth-client';

export default function App() {
  const projectInventory = useProjectInventory();
  const osSession = osAuthClient.useSession();
  const accountLabel = osSession.isPending
    ? 'Checking OS account'
    : osSession.data?.user?.email ?? 'Signed out of OS account';

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <HeroUINativeProvider>
          <ProjectOverviewScreen
            accountLabel={accountLabel}
            errorMessage={projectInventory.errorMessage}
            inventory={projectInventory.inventory}
            isRefreshing={projectInventory.isRefreshing}
            onRefresh={projectInventory.refresh}
            sourceLabel={projectInventory.sourceLabel}
          />
        </HeroUINativeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
