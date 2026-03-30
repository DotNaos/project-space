import { getChannelBuildMeta, normalizeChannel } from './scripts/build/channel-build-meta.mjs';

const hasMacSigningIdentity = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
const releaseChannel = normalizeChannel(process.env.RELEASE_CHANNEL);
const channelBuildMeta = getChannelBuildMeta(releaseChannel);

export default {
  appId: channelBuildMeta.appId,
  productName: channelBuildMeta.bundleLabel,
  asar: true,
  npmRebuild: false,
  directories: {
    output: 'release',
    buildResources: 'build'
  },
  files: [
    'dist/renderer/**/*',
    'dist-electron/**/*',
    'assets/**/*',
    'build/runtime-icons/**/*',
    'node_modules/**/*',
    'package.json'
  ],
  extraMetadata: {
    main: 'dist-electron/main/index.js',
    projectSpaceChannel: releaseChannel
  },
  mac: {
    category: 'public.app-category.productivity',
    target: ['dmg', 'zip'],
    icon: 'build/icon.icns',
    identity: hasMacSigningIdentity ? undefined : '-'
  }
};
