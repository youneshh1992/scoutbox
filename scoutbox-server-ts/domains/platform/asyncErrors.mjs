// Express 4 ignores the promise an async handler returns, so a rejection would be unhandled and Node would end the
// process. This patches Express's own Layer#handle_request (4.x, router/layer.js) to pass the rejection to next(err).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let installed = false;

export function installAsyncErrorForwarding() {
  if (installed) return;
  const Layer = require('express/lib/router/layer.js');
  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // not a standard request handler (Express 4 behaviour)
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') {
        out.then(undefined, (err) => next(err ?? new Error('A route handler rejected without a reason.')));
      }
    } catch (err) {
      next(err);
    }
    return undefined;
  };
  installed = true;
}
