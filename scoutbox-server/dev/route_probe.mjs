// Boots both servers on fresh seeded directories, sends every route the TypeScript tree registers to each with the
// matching role's session, and lists the routes where Gleam's router answers its generic 404 and TypeScript doesn't.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// `node dev/route_probe.mjs`, after a build. Prints the routes to port; uploads are out of scope.
const GL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TS = path.join(GL, "..", "..", "scoutbox", "scoutbox-server");

const walk = (d) =>
	fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
		if (e.name === "node_modules" || e.name === "e2e" || e.name === "scripts")
			return [];
		const p = path.join(d, e.name);
		return e.isDirectory() ? walk(p) : /\.(mjs|ts)$/.test(e.name) ? [p] : [];
	});
const PREFIX = {
	playerRouter: "/player",
	orgRouter: "/org",
	guardianRouter: "/guardian",
	adminRouter: "/admin",
	tsRouter: "/ts",
	app: "",
};
const routes = new Map();
for (const f of walk(TS)) {
	const src = fs.readFileSync(f, "utf8");
	for (const m of src.matchAll(
		/\b(playerRouter|orgRouter|guardianRouter|adminRouter|tsRouter|app)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\3/g,
	)) {
		const [, router, method, , p] = m;
		if (p.includes("${") || p.includes("*")) continue;
		const full = PREFIX[router] + p;
		routes.set(`${method.toUpperCase()} ${full}`, {
			router,
			method: method.toUpperCase(),
			path: full.replace(/:[A-Za-z]+/g, "zz"),
		});
	}
}

const freePort = () =>
	new Promise((resolve) => {
		const s = net.createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});

async function boot(dir) {
	const { serverCommand, serverDir } = await import(
		path.join(dir, "e2e/support/server.mjs")
	);
	const data = fs.mkdtempSync(path.join(os.tmpdir(), "sb-probe-"));
	const port = await freePort();
	const child = spawn(...serverCommand(), {
		cwd: serverDir,
		env: {
			...process.env,
			PORT: String(port),
			DATA_DIR: data,
			SCOUTBOX_QUIET_LOGS: "1",
		},
		stdio: "ignore",
	});
	process.on("exit", () => {
		child.kill("SIGKILL");
		fs.rmSync(data, { recursive: true, force: true });
	});
	const api = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${api}/orgs/directory`)).ok) return api;
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`${dir} did not start`);
}

async function client(api) {
	const post = async (p, body) =>
		(
			await fetch(api + p, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			})
		).json();
	const login = {
		playerRouter: async () =>
			(await post("/auth/player/login", { playerId: "pl-adeyemi" })).token,
		guardianRouter: async () =>
			(await post("/auth/guardian/login", { guardianId: "gd-amara" })).token,
		orgRouter: async () =>
			(
				await post("/auth/org/login", {
					orgId: "org-eastport",
					scoutName: "Maria Keane",
					role: "Head of Recruitment",
				})
			).token,
		tsRouter: async () =>
			(
				await post("/auth/reviewer/login", {
					reviewerId: "tsr-dev-admin",
					secret: "dev-reviewer-admin",
				})
			).token,
	};
	const tokens = {};
	const headers = async (router, fresh = false) => {
		const h = { "content-type": "application/json" };
		if (router === "adminRouter")
			h["x-admin-key"] = process.env.ADMIN_KEY || "scoutbox-admin";
		else if (login[router]) {
			if (fresh || !tokens[router]) tokens[router] = await login[router]();
			h.authorization = `Bearer ${tokens[router]}`;
		}
		return h;
	};
	return async (r) => {
		const send = async (fresh) => {
			const res = await fetch(api + r.path, {
				method: r.method,
				headers: await headers(r.router, fresh),
				body: r.method === "GET" ? undefined : "{}",
			});
			let error = null;
			try {
				error = (await res.json())?.error ?? null;
			} catch {}
			return { status: res.status, error };
		};
		let out = await send(false);
		if (out.status === 401) out = await send(true);
		return out;
	};
}

const [tsApi, glApi] = await Promise.all([boot(TS), boot(GL)]);
const [ts, gl] = await Promise.all([client(tsApi), client(glApi)]);
const order = { GET: 0, POST: 1, PUT: 1, PATCH: 1, DELETE: 2 };
const list = [...routes.values()].sort(
	(a, b) => order[a.method] - order[b.method],
);
const missing = [];
const inconclusive = [];
for (const r of list) {
	const [a, b] = [await ts(r), await gl(r)];
	const generic = (x) => x.status === 404 && x.error === "NOT_FOUND";
	if (generic(b) && !generic(a))
		missing.push(`${r.method} ${r.path}  (TypeScript ${a.status} ${a.error})`);
	else if ([429, 401].includes(b.status) || [429, 401].includes(a.status))
		inconclusive.push(
			`${r.method} ${r.path}  ts=${a.status} ${a.error} gleam=${b.status} ${b.error}`,
		);
}
console.log(`${list.length} routes probed`);
console.log(`MISSING in Gleam (${missing.length}):\n  ` + missing.join("\n  "));
console.log(
	`INCONCLUSIVE (${inconclusive.length}):\n  ` + inconclusive.join("\n  "),
);
process.exit(0);
