// What the integrations domain offers the rest of the server to import: its vocabulary, pure rules and views. Nothing here
// holds state or registers a route; the domain's services reach other domains through server.mjs, not through here.
export { signBody } from './webhooks.mjs';
