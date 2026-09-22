const appJson = require('./app.json');

// Le build de développement (dev client) ne cible que arm64 : APK plus léger, installation plus rapide.
// La production garde la liste d'architectures par défaut.
const isDevelopmentBuild = process.env.EAS_BUILD_PROFILE === 'development';

const plugins = (appJson.expo.plugins ?? []).map((plugin) =>
  isDevelopmentBuild && Array.isArray(plugin) && plugin[0] === 'expo-build-properties'
    ? [plugin[0], { ...plugin[1], android: { ...plugin[1].android, buildArchs: ['arm64-v8a'] } }]
    : plugin
);

module.exports = {
  ...appJson.expo,
  plugins,
  android: {
    ...appJson.expo.android,
    // EAS exposes file variables as absolute paths on the build worker.
    googleServicesFile:
      process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
  },
};
