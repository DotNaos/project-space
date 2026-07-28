const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
const { withUniwindConfig } = require('uniwind/metro');
const {
  wrapWithReanimatedMetroConfig,
} = require('react-native-reanimated/metro-config');

const config = getDefaultConfig(__dirname);
const repositoryRoot = path.resolve(__dirname, '../..');

config.watchFolders = [repositoryRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(repositoryRoot, 'node_modules'),
];

module.exports = withUniwindConfig(wrapWithReanimatedMetroConfig(config), {
  cssEntryFile: './global.css',
  dtsFile: './src/uniwind.d.ts',
});
