/**
 * Transport-rig child process (run under NODE, not bun: bun does not
 * reproduce undici's socket timer semantics, see proxy-rig.test.ts).
 *
 * Self-contained per invocation: hosts an HTTP backend that delays its
 * response headers, and — for proxy-ON cases — a local loopback proxy that
 * speaks both plain absolute-form forwarding and CONNECT tunneling (the
 * latter is what EnvHttpProxyAgent uses with proxyTunnel enabled, so the ON
 * cases genuinely traverse the proxy). Builds the same dispatcher
 * applyProxyPreference() installs from the serialized pi-parity transport
 * options, performs one fetch, and prints a single RESULT json line:
 *   { ok, status?, elapsedMs, code?, connectCount, backendHits }
 * connectCount/backendHits prove the ON requests actually went through the
 * proxy tunnel to the backend instead of bypassing it.
 *
 * usage: node rig-child.mjs <case> <undiciPath>
 *   case: off-fire | off-pass | on-fire | on-pass
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";

const [testCase, undiciPath] = process.argv.slice(2);
const undici = createRequire(import.meta.url)(undiciPath);

/** pi 0.85.1 configureHttpDispatcher option block (serialized from proxy-lib.piTransportOptions in the parent). */
const TRANSPORT = {
	allowH2: false,
	proxyTunnel: true,
	headersTimeout: 0,
	bodyTimeout: 0,
	connect: { autoSelectFamilyAttemptTimeout: 2000 },
};
const SHORT = 300;
const LONG = 5000;

/** Mirror of proxy-lib.withUndiciErrorListener (unit-tested on the parent side). */
function withErrorListener(dispatcher) {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", () => {});
	}
	return dispatcher;
}

/** Mirror of proxy-lib.undiciFactories. */
function factories() {
	const clientFactory = (origin, opts) => withErrorListener(new undici.Client(origin, opts));
	const factory = (origin, opts) => {
		const o = opts ?? {};
		if (o.connections === 1) return clientFactory(origin, o);
		return withErrorListener(new undici.Pool(origin, { ...o, factory: clientFactory }));
	};
	return { clientFactory, factory };
}

function buildDispatcher(proxyUrl, timeoutMs) {
	const transport = { ...TRANSPORT, headersTimeout: timeoutMs, bodyTimeout: timeoutMs };
	const f = factories();
	if (proxyUrl) {
		return new undici.EnvHttpProxyAgent({
			httpProxy: proxyUrl,
			httpsProxy: proxyUrl,
			...transport,
			clientFactory: f.clientFactory,
			factory: f.factory,
		});
	}
	return new undici.Agent({ ...transport, factory: f.factory });
}

const listen = (server) =>
	new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

let backendHits = 0;
let connectCount = 0;

const backend = http.createServer((req, res) => {
	backendHits++;
	const delay = Number(new URL(req.url ?? "/", "http://x").searchParams.get("delay") ?? 0);
	setTimeout(() => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("ok");
	}, delay);
});
const proxy = http.createServer((req, res) => {
	// Plain absolute-form forwarding (used when the client does not tunnel).
	http
		.get(req.url ?? "", (up) => {
			res.writeHead(up.statusCode ?? 502, up.headers);
			up.pipe(res);
		})
		.on("error", () => {
			res.writeHead(502);
			res.end();
		});
});
// CONNECT tunneling: open a TCP pipe to the requested host:port and relay
// raw bytes both ways. Failures answer 502 instead of hanging the client.
proxy.on("connect", (req, clientSocket, head) => {
	connectCount++;
	const [host, portText] = (req.url ?? "").split(":");
	const target = net.connect(Number(portText), host, () => {
		clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head?.length) target.write(head);
		target.pipe(clientSocket);
		clientSocket.pipe(target);
	});
	target.on("error", () => {
		try {
			clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		} catch {
			// The client is already gone; nothing left to report to.
		}
		clientSocket.destroy();
	});
	clientSocket.on("error", () => target.destroy());
});

const backendPort = await listen(backend);
const proxyPort = testCase.startsWith("on-") ? await listen(proxy) : null;
const [mode, delayMs, timeoutMs] =
	testCase.endsWith("fire") ? ["fire", 2500, SHORT] : ["pass", 800, LONG];
const dispatcher = buildDispatcher(proxyPort ? `http://127.0.0.1:${proxyPort}` : undefined, timeoutMs);

function report(result) {
	console.log("RESULT", JSON.stringify({ ...result, connectCount, backendHits }));
}

const t0 = Date.now();
try {
	const res = await undici.fetch(`http://127.0.0.1:${backendPort}/x?delay=${delayMs}`, { dispatcher });
	await res.text();
	report({ ok: true, status: res.status, elapsedMs: Date.now() - t0 });
} catch (e) {
	const code = e?.cause?.code ?? e?.code ?? e?.message;
	report({ ok: false, elapsedMs: Date.now() - t0, code: String(code) });
}
await dispatcher.close?.();
proxy.close();
backend.close();
process.exit(0);
