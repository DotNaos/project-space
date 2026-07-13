import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { createCodexSessionsClient } from '@/api/codex-sessions-client';
import { refreshProjectSpaceAuthToken } from '@/api/project-space-client';
import { CodexSessionsController } from '../../codex-sessions/codex-sessions-controller';
import {
  parseCodexSessionRoute,
  writeCodexSessionRoute,
  type CodexSessionTarget
} from '../../codex-sessions/codex-session-route';
import type { ConnectorOverviewResult } from '@/shared/project-space-api';
import type { ProjectMainView } from './project-desktop-routing';

function currentTarget(): CodexSessionTarget | undefined {
  if (typeof window === 'undefined') return undefined;
  const route = parseCodexSessionRoute(window.location.pathname);
  return route.matches && route.machineId && route.threadId
    ? { machineId: route.machineId, threadId: route.threadId }
    : undefined;
}

export function useCodexDesktop({
  connectorOverview,
  setMainView
}: {
  connectorOverview: ConnectorOverviewResult;
  setMainView: Dispatch<SetStateAction<ProjectMainView>>;
}) {
  const [selectedOrigin, setSelectedOrigin] = useState<CodexSessionTarget | undefined>(currentTarget);
  const controller = useMemo(() => new CodexSessionsController(createCodexSessionsClient({
    getAuthToken: refreshProjectSpaceAuthToken
  })), []);
  const machineIds = useMemo(() => (
    [...new Set(connectorOverview.machines.map((machine) => machine.id).filter(Boolean))]
  ), [connectorOverview.machines]);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    const handlePopState = () => {
      const route = parseCodexSessionRoute(window.location.pathname);
      if (!route.matches) return;
      setSelectedOrigin(route.machineId && route.threadId
        ? { machineId: route.machineId, threadId: route.threadId }
        : undefined);
      setMainView('codex');
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [setMainView]);

  return {
    codexController: controller,
    codexMachineIds: machineIds,
    selectedCodexOrigin: selectedOrigin,
    openCodex(target?: CodexSessionTarget) {
      setSelectedOrigin(target);
      setMainView('codex');
      writeCodexSessionRoute(target);
    }
  };
}
