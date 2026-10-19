#!/usr/bin/env node
// FeaturePulse E2E runner. Drives the system Chrome over the DevTools Protocol.
// Usage: node run_test.mjs <spec.json>
//   spec = { chrome_path?, target_url, steps:[...], out_dir, default_timeout?, allowed_hosts?:[...] }
// Emits a single JSON result object on stdout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const specPath = process.argv[2];
if (!specPath) {
  console.log(JSON.stringify({ status: "Error", error: "no spec file" }));
  process.exit(0);
}
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const DEF_TIMEOUT = spec.default_timeout || 15000;
const outDir = spec.out_dir;
fs.mkdirSync(outDir, { recursive: true });

// Egress allowlist — the real enforcement point, since this is what actually issues navigations.
// Empty/absent = unrestricted (matches the backend's default-open policy for local/dev use).
const ALLOWED_HOSTS = (spec.allowed_hosts || []).map((h) => String(h).toLowerCase());
function hostAllowed(url) {
  if (ALLOWED_HOSTS.length === 0) return true;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (!host) return false;
  return ALLOWED_HOSTS.some((pat) =>
    pat.startsWith("*.") ? host === pat.slice(2) || host.endsWith(pat.slice(1)) : host === pat,
  );
}

function findChrome() {
  if (spec.chrome_path && fs.existsSync(spec.chrome_path)) return spec.chrome_path;
  const cands = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

const result = {
  status: "Pass",
  started_at: new Date().toISOString(),
  duration_ms: 0,
  steps: [],
  screenshots: [],
  console_errors: [],
  error: null,
};
const t0 = Date.now();

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error("No Chrome/Chromium found. Set CHROME_PATH.");
  const port = 9100 + Math.floor(Math.random() * 800);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fp-run-"));
  const proc = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--window-size=1366,900", "about:blank",
  ], { stdio: "ignore" });

  const cleanup = () => { try { proc.kill("SIGKILL"); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} };

  try {
    // wait for devtools endpoint
    let ver = null;
    for (let i = 0; i < 40; i++) {
      try { ver = await (await fetch(`http://localhost:${port}/json/version`)).json(); break; } catch { await sleep(250); }
    }
    if (!ver) throw new Error("Chrome did not expose a debugging endpoint");

    const tab = await (await fetch(`http://localhost:${port}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
    await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
      else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        result.console_errors.push((m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
      } else if (m.method === "Runtime.exceptionThrown") {
        result.console_errors.push((m.params.exceptionDetails?.exception?.description || "uncaught exception").slice(0, 300));
      }
    });
    await send("Page.enable"); await send("Runtime.enable");

    const evalJs = async (expr, timeout = DEF_TIMEOUT) => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate failed");
      return r.result.value;
    };
    // Poll a JS boolean expression until true or timeout.
    const waitExpr = async (expr, timeout) => {
      const end = Date.now() + (timeout || DEF_TIMEOUT);
      let last;
      while (Date.now() < end) { last = await evalJs(`!!(${expr})`); if (last) return true; await sleep(200); }
      return false;
    };
    const sel = (s) => JSON.stringify(s);
    const screenshot = async (name) => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      const fn = `${String(result.screenshots.length + 1).padStart(2, "0")}-${(name || "shot").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40)}.png`;
      fs.writeFileSync(path.join(outDir, fn), Buffer.from(r.data, "base64"));
      result.screenshots.push(fn);
      return fn;
    };

    const navigate = async (url) => {
      if (!hostAllowed(url)) throw new Error(`Blocked by egress allowlist: ${url}`);
      await send("Page.navigate", { url });
      await waitExpr("document.readyState==='complete'", DEF_TIMEOUT);
      await sleep(300); // let SPA frameworks (Angular/React) settle
      // re-check after load: a redirect (server or client-side) could have left the allowlist
      const landed = await evalJs("location.href").catch(() => null);
      if (landed && !hostAllowed(landed)) throw new Error(`Blocked by egress allowlist: navigated to ${landed}`);
    };

    // first navigation to the target
    await navigate(spec.target_url);

    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i];
      const st0 = Date.now();
      const rec = { index: i + 1, action: step.action, ok: true, message: "", ms: 0 };
      try {
        const to = step.timeout || DEF_TIMEOUT;
        switch (step.action) {
          case "goto":
            await navigate(step.url || spec.target_url); rec.message = step.url || spec.target_url; break;
          case "wait":
            await sleep(step.timeout || 1000); rec.message = `${step.timeout || 1000}ms`; break;
          case "waitFor": {
            const cond = step.text
              ? `[...document.querySelectorAll(${sel(step.selector || "body")})].some(e=>e.textContent.includes(${sel(step.text)}))`
              : `document.querySelector(${sel(step.selector)})`;
            const ok = await waitExpr(cond, to);
            if (!ok) throw new Error(`timed out waiting for ${step.selector || ""}${step.text ? " text:" + step.text : ""}`);
            rec.message = step.selector || step.text || ""; break;
          }
          case "click": {
            const ok = await waitExpr(`document.querySelector(${sel(step.selector)})`, to);
            if (!ok) throw new Error(`element not found: ${step.selector}`);
            await evalJs(`(()=>{const el=document.querySelector(${sel(step.selector)});el.scrollIntoView({block:'center'});el.click();return true;})()`);
            await sleep(250);
            // a click can itself trigger navigation (e.g. a link) — re-check the allowlist
            const here = await evalJs("location.href").catch(() => null);
            if (here && !hostAllowed(here)) throw new Error(`Blocked by egress allowlist: navigated to ${here}`);
            rec.message = step.selector; break;
          }
          case "fill": {
            const ok = await waitExpr(`document.querySelector(${sel(step.selector)})`, to);
            if (!ok) throw new Error(`input not found: ${step.selector}`);
            await evalJs(`(()=>{const el=document.querySelector(${sel(step.selector)});const set=Object.getOwnPropertyDescriptor(el.__proto__,'value')?.set||Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(el,${sel(step.value ?? "")});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
            rec.message = `${step.selector} = ${String(step.value ?? "").slice(0, 40)}`; break;
          }
          case "expectVisible": {
            const ok = await waitExpr(`(()=>{const e=document.querySelector(${sel(step.selector)});if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;})()`, to);
            if (!ok) throw new Error(`not visible: ${step.selector}`);
            rec.message = step.selector; break;
          }
          case "expectText": {
            const scope = step.selector || "body";
            const ok = await waitExpr(`[...document.querySelectorAll(${sel(scope)})].some(e=>e.textContent.includes(${sel(step.text)}))`, to);
            if (!ok) throw new Error(`text not found in ${scope}: "${step.text}"`);
            rec.message = `${scope} contains "${step.text}"`; break;
          }
          case "screenshot":
            rec.message = await screenshot(step.name); break;
          default:
            throw new Error(`unknown action: ${step.action}`);
        }
      } catch (e) {
        rec.ok = false; rec.message = String(e.message || e);
        result.status = "Fail";
      }
      rec.ms = Date.now() - st0;
      result.steps.push(rec);
      if (!rec.ok) { try { await screenshot(`fail-step-${i + 1}`); } catch {} break; }
    }
    // always capture a final frame if nothing failed mid-way
    if (result.status === "Pass") { try { await screenshot("final"); } catch {} }
    ws.close();
  } finally {
    cleanup();
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main()
  .catch((e) => { result.status = "Error"; result.error = String(e.message || e); })
  .finally(() => { result.duration_ms = Date.now() - t0; console.log(JSON.stringify(result)); process.exit(0); });
