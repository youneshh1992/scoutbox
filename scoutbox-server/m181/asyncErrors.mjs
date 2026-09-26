// PRE-M24 (PM-9) — a rejected promise from a route handler reaches the error
// middleware instead of the process.
//
// Express 4 catches an error THROWN by a handler and passes it to next(err),
// but it ignores the promise an `async` handler returns. A throw inside an
// async handler therefore became an unhandled rejection, and Node ends the
// process on one: a single malformed request (`{"email": {}}` to
// /org/verification/email, or a bad body to either unauthenticated async
// route — guardian signup, org verification apply) stopped the whole server
// for every user.
//
// This mirrors Express's own Layer#handle_request (4.x, router/layer.js) line
// for line and adds one thing: when the handler returns a thenable, its
// rejection is passed to next(err). Error middleware (four arguments) keeps
// Express's rule of being skipped on the normal path. The existing app-level
// error handler then answers the caller with its fixed 500 body and logs the
// detail — exactly what a synchronous throw already got.
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
