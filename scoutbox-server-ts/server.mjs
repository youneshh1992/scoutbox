// ScoutBox sync backend. Kept in plain JavaScript, importing nothing else statically: an unsupported Node.js can't load
// the TypeScript modules, so it would fail while loading them, before any check could say why. The runtime is checked
// first, and the wiring is loaded only on a supported one.
import { requireRuntime } from './runtime.mjs';

requireRuntime();
await import('./wiring.mjs');
