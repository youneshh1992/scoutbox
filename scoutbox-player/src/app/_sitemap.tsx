// PRE-M24 (PM-13): expo-router serves a developer route list at /_sitemap in
// every build unless the app defines its own. The production export showed
// every source route file, the SDK version and the build mode to anyone who
// typed the path. This screen replaces it with the ordinary not-found screen.
export { default } from './+not-found';
