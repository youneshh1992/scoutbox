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
