module.exports = ({ config }) => ({
  ...config,
  ...(process.env.EXPO_PUBLIC_PROJECT_SPACE_PROTOTYPE === '1'
    ? {
        experiments: {
          ...config.experiments,
          baseUrl: '/prototype/mobile',
        },
      }
    : {}),
});
