import { FigmaCaptureDevButton } from '@/app/components/figma-capture-button';
import { ProjectDesktopShell } from '@/features/project-desktop/components/project-desktop-shell';

export function App() {
  return (
    <>
      <ProjectDesktopShell />
      <FigmaCaptureDevButton />
    </>
  );
}
