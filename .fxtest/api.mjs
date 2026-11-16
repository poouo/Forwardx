// Minimal tRPC client for the test panel. Usage: node api.mjs q|m <path> [json]
import fs from "node:fs";
const BASE = process.env.FXT_BASE || "http://127.0.0.1:3000";
const JAR = process.env.FXT_JAR || "/tmp/fxt-cookie.txt";
export async function call(kind, path, input) {
  const cookie = fs.existsSync(JAR) ? fs.readFileSync(JAR, "utf8").trim() : "";
  const headers = { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) };
  let url = `${BASE}/api/trpc/${path}`;
  const init = { method: kind === "q" ? "GET" : "POST", headers };
  if (kind === "q") { if (input !== undefined) url += `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`; }
  else init.body = JSON.stringify({ json: input ?? null });
  const res = await fetch(url, init);
  const set = res.headers.getSetCookie?.() || [];
  if (set.length) {
    const jar = new Map((cookie ? cookie.split("; ") : []).map((c) => [c.split("=")[0], c]));
    for (const c of set) { const pair = c.split(";")[0]; jar.set(pair.split("=")[0], pair); }
    fs.writeFileSync(JAR, [...jar.values()].join("; "));
  }
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`); }
  if (body.error) throw new Error(`${path}: ${body.error.json?.message || JSON.stringify(body.error).slice(0, 400)}`);
  return body.result?.data?.json;
}
if (process.argv[1] && process.argv[1].endsWith("api.mjs")) {
  const [kind, path, json] = process.argv.slice(2);
  call(kind, path, json ? JSON.parse(json) : undefined)
    .then((r) => console.log(JSON.stringify(r, null, 1)?.slice(0, Number(process.env.FXT_MAX || 3000))))
    .catch((e) => { console.error("ERR", e.message); process.exit(1); });
}
