const projectChatPath = '/chat';
const projectRoomsPath = `${projectChatPath}/projects`;

export function projectChatRoute(projectId?: string) {
  return projectId
    ? `${projectRoomsPath}/${encodeURIComponent(projectId)}`
    : projectChatPath;
}

export function parseProjectChatRoute(pathname: string) {
  if (pathname === projectChatPath || pathname === `${projectChatPath}/`) {
    return { matches: true as const, projectId: undefined };
  }
  if (!pathname.startsWith(`${projectRoomsPath}/`)) {
    return { matches: false as const, projectId: undefined };
  }
  const encoded = pathname.slice(projectRoomsPath.length + 1);
  if (!encoded || encoded.includes('/')) {
    return { matches: false as const, projectId: undefined };
  }
  try {
    const projectId = decodeURIComponent(encoded);
    return projectId
      ? { matches: true as const, projectId }
      : { matches: false as const, projectId: undefined };
  } catch {
    return { matches: false as const, projectId: undefined };
  }
}
