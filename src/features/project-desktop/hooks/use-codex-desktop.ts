import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { createCodexSessionsClient } from '@/api/codex-sessions-client';
import {
  projectSpaceClient,
  refreshProjectSpaceAuthToken,
  resolveProjectSpaceApiBaseUrl
} from '@/api/project-space-client';
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
    baseUrl: typeof window === 'undefined'
      ? ''
      : resolveProjectSpaceApiBaseUrl(
          window.location.href,
          import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL
        ),
    getAuthToken: refreshProjectSpaceAuthToken
  }), undefined, (machineId, signal) => projectSpaceClient.getMachineRuntime(machineId, signal)), []);
  const machineIds = useMemo(() => (
    [...new Set(connectorOverview.machines.map((machine) => machine.id).filter(Boolean))]
  ), [connectorOverview.machines]);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    const route = parseCodexSessionRoute(window.location.pathname);
    if (route.matches && route.legacy && route.canonicalPath) {
      window.history.replaceState(
        null,
        '',
        `${route.canonicalPath}${window.location.search}${window.location.hash}`
      );
    }
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const route = parseCodexSessionRoute(window.location.pathname);
      if (!route.matches) return;
      if (route.legacy && route.canonicalPath) {
        window.history.replaceState(
          null,
          '',
          `${route.canonicalPath}${window.location.search}${window.location.hash}`
        );
      }
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
