// The app imports the repository's shared rules (../shared), outside this project's root. Expo's on-demand
// filesystem reads nothing outside the project, so app.json turns it off (experiments.onDemandFilesystem) and the
// watch folders are crawled instead.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../shared')];

module.exports = config;
