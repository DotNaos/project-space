import './global.css';

import { lazy, Suspense } from 'react';
import { HeroUINativeProvider } from 'heroui-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { MobilePrototypeApp } from './src/prototype/mobile-prototype-app';
import { PrototypeAnnotationBridge } from './src/prototype/prototype-annotation-bridge';

const prototypeEnabled =
  process.env.EXPO_PUBLIC_PROJECT_SPACE_PROTOTYPE === '1';
const ProjectSpaceMobileApp = lazy(async () => {
  const runtime = await import(
    './src/prototype/project-space-mobile-runtime'
  );
  return { default: runtime.ProjectSpaceMobileRuntime };
});
export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <HeroUINativeProvider>
          {prototypeEnabled ? (
            <>
              <MobilePrototypeApp />
              <PrototypeAnnotationBridge />
            </>
          ) : (
            <Suspense fallback={null}>
              <ProjectSpaceMobileApp />
            </Suspense>
          )}
        </HeroUINativeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
