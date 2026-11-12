// What the passport domain offers the rest of the server to import: its vocabulary, pure rules and views. Nothing here
// holds state or registers a route; the domain's services reach other domains through server.mjs, not through here.
export { POLICY, TRUST_SCORE_POLICY_VERSION } from './trust/shared.mjs';
