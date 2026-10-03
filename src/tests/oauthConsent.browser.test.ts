import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:https";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubHandler } from "../worker/github-handler.js";
import { oauthFixture } from "./helpers/oauth.js";

// Explicit opt-in: requires a local Chromium binary. No live OAuth or API calls.
const browserDescribe = process.env.YNAB_BROWSER_TESTS === "true" ? describe : describe.skip;
browserDescribe("real browser consent submission", () => {
  let directory: string, browser: ChildProcess, socket: WebSocket;
  let server: ReturnType<typeof createServer>, origin: string;
  let send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  const posts: Array<{ origin: string | null; cookiePresent: boolean; status: number }> = [];
  let githubRedirects = 0;
  let replayForm = "", foreignForm = "";
  const browserErrors: string[] = [];
  const f = oauthFixture();
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "ynab-browser-regression-"));
    // Disposable, self-signed local test certificate, never a production credential.
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-subj", "/CN=worker.example", "-days", "1"], { stdio: "ignore" });
    server = createServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) }, async (req, res) => {
      try {
        if (req.url === "/replay") {
          res.writeHead(200, { "content-type": "text/html", "referrer-policy": "same-origin" });
          res.end(replayForm); return;
        }
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        const request = new Request(`${origin}${req.url}`, { method: req.method, headers, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
        const response = await GitHubHandler.fetch(request, f.env);
        if (req.method === "POST") posts.push({ origin: headers.get("origin"), cookiePresent: headers.has("cookie"), status: response.status });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
      } catch { res.writeHead(500); res.end("Synthetic harness failure"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `https://worker.example:${(server.address() as { port: number }).port}`;
    f.env.PUBLIC_ORIGIN = origin;
    browser = spawn(process.env.CHROMIUM_PATH || "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--no-proxy-server", "--disable-background-networking", "--disable-component-update", "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors", "--host-resolver-rules=MAP worker.example 127.0.0.1, MAP * ~NOTFOUND", `--user-data-dir=${directory}/profile`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = ""; const timer = setTimeout(() => reject(new Error("Chromium startup timed out")), 10000);
      browser.once("error", reject);
      browser.stderr!.on("data", chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", reject, { once: true }); });
    let sequence = 0, sessionId: string | undefined;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Log.entryAdded" && message.params.entry.source === "security") browserErrors.push(message.params.entry.text);
      if (message.id) { const waiter = pending.get(message.id); pending.delete(message.id); message.error ? waiter?.reject(new Error(message.error.message)) : waiter?.resolve(message.result); }
      if (message.method === "Fetch.requestPaused") {
        const { requestId, request } = message.params;
        if (new URL(request.url).origin === origin) void send("Fetch.continueRequest", { requestId });
        else {
          if (request.url.startsWith("https://github.com/login/oauth/authorize?")) githubRedirects++;
          void send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }], body: Buffer.from(request.url.startsWith("https://foreign.example/") ? foreignForm : "Synthetic external navigation intercepted").toString("base64") });
        }
      }
    });
    const targets = await send("Target.getTargets");
    sessionId = (await send("Target.attachToTarget", { targetId: targets.targetInfos.find((target: { type: string }) => target.type === "page").targetId, flatten: true })).sessionId;
    await send("Log.enable"); await send("Page.enable"); await send("Network.enable"); await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  }, 20000);
  afterAll(async () => {
    socket?.close();
    if (browser && browser.exitCode === null) { browser.kill("SIGTERM"); await new Promise(resolve => browser.once("exit", resolve)); }
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function evaluate(expression: string) { return (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value; }
  async function openConsent() {
    await send("Page.navigate", { url: `${origin}/authorize` });
    await expect.poll(() => evaluate('Boolean(document.querySelector("button[value=approve]"))')).toBe(true);
  }
  async function approve() { await evaluate('document.querySelector("form").requestSubmit(document.querySelector("button[value=approve]"))'); }
  it("sends a browser-generated canonical Origin and reaches the intercepted GitHub redirect", async () => {
    await openConsent(); const before = posts.length;
    await approve(); await expect.poll(() => posts.length).toBe(before + 1);
    expect(posts.at(-1)).toEqual({ origin, cookiePresent: true, status: 302 });
    await expect.poll(() => githubRedirects + browserErrors.length).toBeGreaterThan(0);
    expect(browserErrors).toEqual([]);
    expect(githubRedirects).toBe(1);
  });
  it("rejects a real form submission with a tampered CSRF token", async () => {
    await openConsent(); await evaluate('document.querySelector("input[name=csrf_token]").value="forged"');
    const before = posts.length; await approve(); await expect.poll(() => posts.length).toBe(before + 1);
    expect(posts.at(-1)).toMatchObject({ origin, status: 400 });
  });
  it("rejects a real form submission after its browser cookie is removed", async () => {
    await openConsent(); await send("Network.clearBrowserCookies");
    const before = posts.length; await approve(); await expect.poll(() => posts.length).toBe(before + 1);
    expect(posts.at(-1)).toEqual({ origin, cookiePresent: false, status: 400 });
  });
  it("rejects a second approval of the same form with the original cookie", async () => {
    await openConsent(); replayForm = await evaluate('document.querySelector("form").outerHTML');
    const initialPosts = posts.length, initialRedirects = githubRedirects;
    await approve(); await expect.poll(() => githubRedirects).toBe(initialRedirects + 1);
    expect(posts.at(-1)).toMatchObject({ origin, status: 302 });
    await send("Page.navigate", { url: `${origin}/replay` });
    await expect.poll(() => evaluate('Boolean(document.querySelector("button[value=approve]"))')).toBe(true);
    await approve(); await expect.poll(() => posts.length).toBe(initialPosts + 2);
    expect(posts.at(-1)).toEqual({ origin, cookiePresent: true, status: 400 });
  });
  it("rejects a browser-generated foreign Origin even with copied valid form fields", async () => {
    await openConsent();
    foreignForm = (await evaluate('document.querySelector("form").outerHTML')).replace('action="/authorize"', `action="${origin}/authorize"`);
    await send("Page.navigate", { url: "https://foreign.example/" });
    await expect.poll(() => evaluate('location.origin')).toBe("https://foreign.example");
    const before = posts.length; await approve(); await expect.poll(() => posts.length).toBe(before + 1);
    expect(posts.at(-1)).toMatchObject({ origin: "https://foreign.example", status: 400 });
  });

});
