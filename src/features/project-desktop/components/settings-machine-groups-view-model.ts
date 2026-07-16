export type SettingsMachineGroupsStatus = 'error' | 'loading' | 'ready' | 'refreshing';

export function settingsMachineGroupsPresentation(status: SettingsMachineGroupsStatus) {
  return {
    showBlockingError: status === 'error',
    showBlockingLoading: status === 'loading',
    showContent: status === 'ready' || status === 'refreshing',
    showRefreshing: status === 'refreshing'
  };
}
