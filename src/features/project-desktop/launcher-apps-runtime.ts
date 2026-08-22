import type { AppMeta } from '../../shared/project-space-api';

export function supportsLocalLauncherApps(meta: AppMeta) {
  return meta.runtime?.data === 'local';
}
