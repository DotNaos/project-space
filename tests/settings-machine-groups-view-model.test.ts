import { describe, expect, test } from 'bun:test';
import { settingsMachineGroupsPresentation } from '../src/features/project-desktop/components/settings-machine-groups-view-model';

describe('Settings machine groups presentation', () => {
  test('keeps the last known connector content visible during a background refresh', () => {
    expect(settingsMachineGroupsPresentation('refreshing')).toEqual({
      showBlockingError: false,
      showBlockingLoading: false,
      showContent: true,
      showRefreshing: true
    });
  });

  test('uses a blocking placeholder only before the first result', () => {
    expect(settingsMachineGroupsPresentation('loading')).toEqual({
      showBlockingError: false,
      showBlockingLoading: true,
      showContent: false,
      showRefreshing: false
    });
  });

  test('renders known content normally after refresh completion', () => {
    expect(settingsMachineGroupsPresentation('ready')).toEqual({
      showBlockingError: false,
      showBlockingLoading: false,
      showContent: true,
      showRefreshing: false
    });
  });
});
