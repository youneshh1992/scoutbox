// Child processes started by a test suite (real servers, crash children,
// lock holders) never outlive it. `spawnChild` is `child_process.spawn` plus
// tracking: when the suite exits for any reason (pass, failed assertion,
// uncaught error, Ctrl-C, a SIGTERM from a timeout or CI), every child still
// running is SIGKILLed. Without this a failing case leaves its server
// listening on a temporary directory until someone kills it by hand.
import { spawn } from 'node:child_process';

const children = new Set();
let installed = false;

function killAll() {
  for (const proc of children) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  children.clear();
}

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', killAll);
  // A signal handler replaces Node's default "terminate": exit explicitly, so
  // the 'exit' handler above runs and the suite still ends with the signal's code.
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]) {
    process.on(signal, () => process.exit(code));
  }
}

export function spawnChild(command, args, options) {
  install();
  const proc = spawn(command, args, options);
  children.add(proc);
  proc.on('exit', () => children.delete(proc));
  return proc;
}
