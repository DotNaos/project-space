import { CODEX_THREAD_ID_PATTERN } from '../../shared/codex-sessions-api';

const codexPath = '/codex';
const machineIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface CodexSessionTarget {
  machineId: string;
  threadId: string;
}

export type ParsedCodexSessionRoute =
  | { matches: false }
  | {
      canonicalPath?: string;
      legacy?: true;
      machineId?: string;
      matches: true;
      threadId?: string;
    };

export function codexSessionRoute(target?: Partial<CodexSessionTarget>) {
  if (!target?.machineId || !target.threadId) return codexPath;
  return `${codexPath}/machines/${encodeURIComponent(target.machineId)}`
    + `/threads/${encodeURIComponent(target.threadId)}`;
}

export function parseCodexSessionRoute(pathname: string): ParsedCodexSessionRoute {
  if (pathname === codexPath || pathname === `${codexPath}/`) {
    return { matches: true as const };
  }
  if (!pathname.startsWith(`${codexPath}/`)) return { matches: false as const };
  const segments = pathname.slice(codexPath.length + 1).split('/');
  const canonical = segments.length === 4
    && segments[0] === 'machines'
    && segments[2] === 'threads';
  const legacy = segments.length === 2;
  if (!canonical && !legacy) return { matches: false as const };
  try {
    const machineId = decodeURIComponent(canonical ? segments[1]! : segments[0]!);
    const threadId = decodeURIComponent(canonical ? segments[3]! : segments[1]!);
    if (!machineIdPattern.test(machineId)) return { matches: false as const };
    if (!CODEX_THREAD_ID_PATTERN.test(threadId)) {
      return { matches: false as const };
    }
    const target = { machineId, threadId };
    return legacy
      ? {
          canonicalPath: codexSessionRoute(target),
          legacy: true as const,
          matches: true as const,
          ...target
        }
      : { matches: true as const, ...target };
  } catch {
    return { matches: false as const };
  }
}

export function writeCodexSessionRoute(target?: Partial<CodexSessionTarget>, replace = false) {
  if (typeof window === 'undefined') return;
  const nextPath = codexSessionRoute(target);
  if (window.location.pathname === nextPath) return;
  const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;
  if (replace) {
    window.history.replaceState(null, '', nextUrl);
  } else {
    window.history.pushState(null, '', nextUrl);
  }
}
