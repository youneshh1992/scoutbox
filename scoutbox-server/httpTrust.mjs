/**
 * Reverse-proxy trust — how the server learns a client's real address.
 *
 * Every per-IP control (the /auth brute-force limiter, sharing-link limits,
 * request logs) keys on `req.ip`. Express only reads X-Forwarded-For when
 * `trust proxy` is set; with nothing set, a server behind a platform proxy
 * (Fly, Render, a load balancer) sees the proxy's address for every client,
 * and a 40-requests-a-minute login limit silently becomes a global one.
 *
 * Trusting the header blindly is the opposite mistake: a client talking to
 * the server directly could then choose its own address. So the setting is
 * explicit, per deployment, through SCOUTBOX_TRUST_PROXY:
 *
 *   unset / 0 / false   nothing is trusted (direct deployments, development)
 *   1, 2, …             that many proxy hops in front of the server
 *   loopback, 10.0.0.0/8, 2001:db8::/32, …   a comma-separated list of
 *                       addresses or subnets that are trusted proxies
 *   true                every hop is trusted — only safe when the proxy
 *                       strips the inbound header; reported as such
 *
 * The parsed value is what `app.set('trust proxy', …)` receives, in the exact
 * forms Express documents. Anything else is reported as invalid and treated
 * as "nothing trusted", and production refuses to boot on it.
 */
import net from 'node:net';

const KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

const validEntry = (entry) => {
  if (KEYWORDS.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length) return false;
  const family = net.isIP(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
};

export function parseTrustProxy(raw) {
  const value = String(raw ?? '').trim();
  if (!value || /^(0|false|off|no)$/i.test(value)) {
    return {
      setting: false, state: 'not_configured', value,
      note: 'No reverse proxy is trusted; the connecting socket address is the client address. Behind a platform proxy every client would share the proxy\'s address and per-IP limits would apply to everyone at once.',
    };
  }
  if (/^(true|all)$/i.test(value)) {
    return {
      setting: true, state: 'configured', value,
      note: 'Every X-Forwarded-For hop is trusted. The client address is spoofable unless the proxy in front of this server strips the inbound header.',
    };
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return {
      setting: hops, state: 'configured', value,
      note: `${hops} proxy hop${hops === 1 ? '' : 's'} in front of the server ${hops === 1 ? 'is' : 'are'} trusted; the client address is read from X-Forwarded-For.`,
    };
  }
  const entries = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length && entries.every(validEntry)) {
    return {
      setting: entries.join(', '), state: 'configured', value,
      note: `Proxies at ${entries.join(', ')} are trusted; the client address is read from X-Forwarded-For.`,
    };
  }
  return {
    setting: false, state: 'invalid', value,
    note: `SCOUTBOX_TRUST_PROXY=${JSON.stringify(value)} is not a hop count, true/false, or a list of addresses and subnets. Nothing is trusted.`,
  };
}
