// What one person's live stream (GET /events) carried while a battery acted: open it, act, then stop to read the
// frames. `j(method, url, body, token)` is the battery's own request helper; `base` its server's address.
export async function liveEvents(base, j, token) {
  const t = await j('POST', '/events/ticket', undefined, token);
  const ac = new AbortController();
  const frames = [];
  const res = await fetch(`${base}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        frames.push(dec.decode(value));
      }
    } catch {
      /* aborted */
    }
  })();
  // Wait for the `connected` frame, so nothing the battery does next falls before the stream is open.
  for (let i = 0; i < 40 && !/"event":"connected"/.test(frames.join('')); i += 1)
    await new Promise((r) => setTimeout(r, 25));
  return {
    /** Waits `ms` for anything still in flight, closes the stream and returns the events it carried. */
    stop: async (ms = 500) => {
      await new Promise((r) => setTimeout(r, ms));
      ac.abort();
      await done;
      return [...frames.join('').matchAll(/^data: (.*)$/gm)]
        .map((m) => JSON.parse(m[1]).event)
        .filter((e) => e !== 'connected');
    },
  };
}

/**
 * One person's live stream (GET /events), kept open while a battery acts: every frame it carries, as parsed `data`
 * (`connected` included), and whether the server ended it. `j` and `base` as for `liveEvents`.
 */
export async function liveStream(base, j, token) {
  const t = await j('POST', '/events/ticket', undefined, token);
  const ac = new AbortController();
  const frames = [];
  let text = '';
  let ended = false;
  const res = await fetch(`${base}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) {
          ended = true;
          break;
        }
        text += dec.decode(value, { stream: true });
        let cut = text.indexOf('\n\n');
        while (cut >= 0) {
          const m = /^data: (.*)$/m.exec(text.slice(0, cut));
          if (m) frames.push(JSON.parse(m[1]));
          text = text.slice(cut + 2);
          cut = text.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted */
    }
  })();
  for (let i = 0; i < 40 && !frames.some((f) => f.event === 'connected'); i += 1)
    await new Promise((r) => setTimeout(r, 25));
  return {
    /** Every frame so far, oldest first. */
    frames: () => frames,
    /** Whether the server closed the stream. */
    ended: () => ended,
    /** Waits up to `ms` for a frame from index `from` on that `match` accepts; the frame, or undefined. */
    waitFor: async (match, from = 0, ms = 3000) => {
      for (let waited = 0; ; waited += 25) {
        const hit = frames.slice(from).find(match);
        if (hit || waited >= ms) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    /** Waits up to `ms` for the server to close the stream. */
    waitForEnd: async (ms = 3000) => {
      for (let waited = 0; !ended && waited < ms; waited += 25) await new Promise((r) => setTimeout(r, 25));
      return ended;
    },
    stop: async () => {
      ac.abort();
      await done;
    },
  };
}
