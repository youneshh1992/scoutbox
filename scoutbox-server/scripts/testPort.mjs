// PRE-M24 (TH-6): a random test port that fetch() will actually connect to.
//
// The suites draw a base port at random so that parallel runs rarely collide,
// then boot servers on base plus a few fixed offsets. The WHATWG Fetch standard refuses a
// fixed list of "bad ports" (5060/5061 SIP, 6000 X11, 6566, 6665–6669 and
// 6697 IRC, …): Node's fetch() fails with "bad port" before it opens a socket.
// Twelve suites' ranges reached one of them, so roughly one run in thirty of
// the unlucky suites died mid-way with no ✗ line — an intermittent failure
// that no product change could cause or fix.
const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export const isFetchBlockedPort = (port) => FETCH_BAD_PORTS.has(port);

/**
 * A base in [base, base + range) such that base + k is fetch-reachable for
 * every offset k the suite boots a server on.
 */
export function pickPort(base, range, offsets = [0]) {
  const usable = [];
  for (let p = base; p < base + range; p += 1) if (offsets.every((k) => !FETCH_BAD_PORTS.has(p + k))) usable.push(p);
  if (!usable.length) throw new Error(`no fetch-reachable port in ${base}+${range} (offsets ${offsets.join(',')})`);
  return usable[Math.floor(Math.random() * usable.length)];
}
