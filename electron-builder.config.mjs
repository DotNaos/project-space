const hasMacSigningIdentity = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

export default {
  appId: 'com.dotnaos.project-space',
  productName: 'Project Space',
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
    'node_modules/**/*',
    'package.json'
  ],
  extraMetadata: {
    main: 'dist-electron/main/index.js'
  },
  mac: {
    category: 'public.app-category.productivity',
    target: ['dmg', 'zip'],
    icon: 'build/icon.icns',
    identity: hasMacSigningIdentity ? undefined : '-'
  }
};
