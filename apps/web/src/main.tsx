import { connectReactDevTools } from '@/devtools/connect-react-devtools';

const enableReactDevTools = false;

async function bootstrap() {
  if (enableReactDevTools) {
    await connectReactDevTools();
  }

  const { startApp } = await import('@/app-entry');
  startApp();
}

void bootstrap();
