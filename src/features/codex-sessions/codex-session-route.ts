import { CODEX_THREAD_ID_PATTERN } from '../../shared/codex-sessions-api';

const codexPath = '/codex';
const machineIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface CodexSessionTarget {
  machineId: string;
  threadId: string;
}

export function codexSessionRoute(target?: Partial<CodexSessionTarget>) {
  if (!target?.machineId) return codexPath;
  const machinePath = `${codexPath}/${encodeURIComponent(target.machineId)}`;
  return target.threadId
    ? `${machinePath}/${encodeURIComponent(target.threadId)}`
    : machinePath;
}

export function parseCodexSessionRoute(pathname: string) {
  if (pathname === codexPath || pathname === `${codexPath}/`) {
    return { matches: true as const };
  }
  if (!pathname.startsWith(`${codexPath}/`)) return { matches: false as const };
  const segments = pathname.slice(codexPath.length + 1).split('/');
  if (segments.length > 2 || !segments[0]) return { matches: false as const };
  try {
    const machineId = decodeURIComponent(segments[0]);
    const threadId = segments[1] ? decodeURIComponent(segments[1]) : undefined;
    if (!machineIdPattern.test(machineId)) return { matches: false as const };
    if (threadId && !CODEX_THREAD_ID_PATTERN.test(threadId)) {
      return { matches: false as const };
    }
    return { matches: true as const, machineId, threadId };
  } catch {
    return { matches: false as const };
  }
}
