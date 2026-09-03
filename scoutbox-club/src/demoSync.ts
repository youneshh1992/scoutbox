// Cross-tab demo sync bus. When the club demo and the player demo run in the
// same browser (same origin), they share one live dataset: requests, responses,
// messages, read receipts and typing all flow between tabs over a
// BroadcastChannel, with a localStorage journal so a tab opened later catches
// up. When no counterpart tab is present, each demo falls back to its built-in
// simulated counterparty. Live (server) mode never uses this file.

export type BusRole = 'club' | 'player';

export interface BusEvent {
  id: string;
  ts: number;
  kind: string; // request | respond | message | read | typing
  from: BusRole;
  payload: Record<string, unknown>;
}

const CHANNEL_NAME = 'scoutbox-demo-bus';
const JOURNAL_KEY = 'scoutbox-demo-journal-v1';
const PRESENCE_KEY = 'scoutbox-demo-presence-v1';
const JOURNAL_CAP = 300;
const PRESENCE_TTL_MS = 12_000;

export interface DemoBus {
  publish(kind: string, payload: Record<string, unknown>): void;
  /** True when a tab of the OTHER role has been alive in the last few seconds. */
  peerActive(): boolean;
  close(): void;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function createDemoBus(role: BusRole, onEvent: (e: BusEvent) => void): DemoBus {
  // Sandboxed hosts make the localStorage GETTER throw — `typeof` included —
  // so the probe itself must sit inside try/catch.
  const storageOk = (() => {
    try {
      localStorage.getItem('__probe__');
      return true;
    } catch {
      return false;
    }
  })();
  const supported =
    typeof BroadcastChannel !== 'undefined' &&
    storageOk &&
    typeof window !== 'undefined';
  if (!supported) {
    return { publish: () => {}, peerActive: () => false, close: () => {} };
  }

  const otherRole: BusRole = role === 'club' ? 'player' : 'club';
  const seen = new Set<string>();
  let seq = 0;
  const nid = () => `${role}-${Date.now().toString(36)}-${++seq}`;

  // Catch up on everything that happened before this tab opened. Deferred a
  // tick so module-level state finishes initialising before replay runs.
  let journalRaw: string | null = null;
  try { journalRaw = localStorage.getItem(JOURNAL_KEY); } catch { /* blocked — no catch-up */ }
  const journal = safeParse<BusEvent[]>(journalRaw, []);
  setTimeout(() => {
    for (const e of journal.sort((a, b) => a.ts - b.ts)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (e.from !== role && e.kind !== 'hello') {
        try { onEvent(e); } catch { /* one bad event must not break replay */ }
      }
    }
  }, 0);

  const appendJournal = (e: BusEvent) => {
    try {
      const list = safeParse<BusEvent[]>(localStorage.getItem(JOURNAL_KEY), []);
      list.push(e);
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(list.slice(-JOURNAL_CAP)));
    } catch { /* storage full/blocked — live channel still works */ }
  };

  const markPresence = (r: BusRole) => {
    try {
      const p = safeParse<Record<string, number>>(localStorage.getItem(PRESENCE_KEY), {});
      p[r] = Date.now();
      localStorage.setItem(PRESENCE_KEY, JSON.stringify(p));
    } catch { /* ignore */ }
  };

  const bc = new BroadcastChannel(CHANNEL_NAME);
  bc.onmessage = (msg: MessageEvent<BusEvent>) => {
    const e = msg.data;
    if (!e || seen.has(e.id)) return;
    seen.add(e.id);
    if (e.kind === 'hello') {
      markPresence(e.from);
      return;
    }
    if (e.from !== role) {
      try { onEvent(e); } catch { /* keep the bus alive */ }
    }
  };

  const hello = () => {
    markPresence(role);
    bc.postMessage({ id: nid(), ts: Date.now(), kind: 'hello', from: role, payload: {} });
  };
  hello();
  const heartbeat = setInterval(hello, 4000);

  return {
    publish(kind, payload) {
      const e: BusEvent = { id: nid(), ts: Date.now(), kind, from: role, payload };
      seen.add(e.id);
      appendJournal(e);
      try { bc.postMessage(e); } catch { /* channel closed */ }
    },
    peerActive() {
      const p = safeParse<Record<string, number>>(localStorage.getItem(PRESENCE_KEY), {});
      return Date.now() - (p[otherRole] ?? 0) < PRESENCE_TTL_MS;
    },
    close() {
      clearInterval(heartbeat);
      bc.close();
    },
  };
}
