// The read-only dashboard: ledger, stats, health and effective config. Minimal black-and-white
// HTML, served by the Worker's fetch handler behind Cloudflare Access.
import type { Config } from "../config/schema";
import { mailboxLink } from "../notify";
import { secretsOf } from "../secrets";
import { fill } from "../template";
import { accessVerifier } from "./access";
import LAYOUT from "./layout.html";
import STYLE from "./style.css";

type Row = Record<string, any>;

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const PAGES = [
  ["/", "Ledger"],
  ["/stats", "Stats"],
  ["/health", "Health"],
  ["/config", "Config"],
] as const;

function page(path: string, title: string, body: string): Response {
  const nav = PAGES.map(([href, label]) => `<a href="${href}"${href === path ? ' class="on"' : ""}>${label}</a>`).join("");
  return new Response(fill(LAYOUT, { title: esc(title), nav, style: STYLE, body }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" },
  });
}

function table(head: string[], rows: string[][], rowClass: (i: number) => string = () => ""): string {
  if (!rows.length) return '<p class="muted">Nothing yet.</p>';
  const th = head.map((h) => `<th>${esc(h)}</th>`).join("");
  const trs = rows.map((r, i) => `<tr${rowClass(i) ? ` class="${rowClass(i)}"` : ""}>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`);
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs.join("")}</tbody></table>`;
}

async function distinct(db: D1Database, column: "watch" | "category"): Promise<string[]> {
  const { results } = await db.prepare(`SELECT DISTINCT ${column} AS v FROM mail ORDER BY v`).all<{ v: string | null }>();
  return results.map((r) => r.v ?? "default");
}

function select(name: string, options: string[], current: string | null): string {
  const opts = ["", ...options].map((o) => `<option value="${esc(o)}"${o === (current ?? "") ? " selected" : ""}>${esc(o || `any ${name}`)}</option>`);
  return `<select name="${name}">${opts.join("")}</select>`;
}

async function ledger(config: Config, db: D1Database, url: URL): Promise<Response> {
  const q = url.searchParams;
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, arg?: unknown) => {
    where.push(sql);
    if (arg !== undefined) args.push(arg);
  };
  const watch = q.get("watch");
  if (watch === "default") add("watch IS NULL");
  else if (watch) add("watch = ?", watch);
  if (q.get("category")) add("category = ?", q.get("category"));
  if (q.get("action")) add("action LIKE ?", `%${q.get("action")}%`);
  const before = Number(q.get("before"));
  if (before > 0) add("id < ?", before);

  const { results } = await db
    .prepare(`SELECT * FROM mail ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 100`)
    .bind(...args)
    .all<Row>();

  const form = [
    '<form method="get" action="/">',
    select("watch", await distinct(db, "watch"), watch),
    select("category", await distinct(db, "category"), q.get("category")),
    select("action", ["forwarded", "dropped", "notified"], q.get("action")),
    "<button>Filter</button></form>",
  ].join("");

  const rows = results.map((r) => {
    const link = mailboxLink(config, { messageId: r.message_id ?? "", subject: r.subject ?? "" })!;
    return [
      esc(r.at?.slice(0, 16).replace("T", " ")),
      esc(r.watch ?? "default"),
      esc(r.category),
      r.confidence == null ? "" : esc(Number(r.confidence).toFixed(2)),
      esc(r.action),
      esc(r.forwarded_to),
      `${esc(r.from_addr)}<br><span class="muted">${esc(r.to_addr)}</span>`,
      `<a href="${esc(link.url)}" target="_blank" rel="noopener">${esc(link.label)}</a>`,
      esc(r.summary),
      esc(r.fields),
      esc(r.error),
      r.r2_key ? `<a href="/raw/${esc(r.id)}">.eml</a>` : "",
    ];
  });
  const more = results.length === 100 ? `<p><a href="?${new URLSearchParams({ ...Object.fromEntries(q), before: String(results[99].id) })}">Older</a></p>` : "";
  const head = ["Time (UTC)", "Watch", "Category", "Conf", "Action", "Forwarded to", "From / to", "Subject", "Summary", "Fields", "Error", "Raw"];
  return page("/", "Ledger", form + table(head, rows, (i) => (results[i].error ? "bad" : "")) + more);
}

async function stats(db: D1Database): Promise<Response> {
  const since = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
  const { results: totals } = await db
    .prepare(
      `SELECT COALESCE(watch, 'default') AS watch, category, COUNT(*) AS total,
         SUM(at >= ?) AS week, SUM(at >= ?) AS month
       FROM mail GROUP BY watch, category ORDER BY watch, total DESC`,
    )
    .bind(since(7), since(30))
    .all<Row>();
  const { results: daily } = await db
    .prepare(
      `SELECT substr(at, 1, 10) AS day, COUNT(*) AS total, SUM(action LIKE '%notified%') AS notified,
         SUM(action = 'dropped') AS dropped, SUM(error IS NOT NULL) AS errors
       FROM mail WHERE at >= ? GROUP BY day ORDER BY day DESC`,
    )
    .bind(since(30))
    .all<Row>();
  const body = [
    "<h2>Per watch and category</h2>",
    table(["Watch", "Category", "Total", "7 days", "30 days"], totals.map((r) => [esc(r.watch), esc(r.category), esc(r.total), esc(r.week), esc(r.month)])),
    "<h2>Per day, last 30 days</h2>",
    table(["Day", "Mail", "Notified", "Dropped", "Errors"], daily.map((r) => [esc(r.day), esc(r.total), esc(r.notified), esc(r.dropped), esc(r.errors)])),
  ].join("");
  return page("/stats", "Stats", body);
}

async function health(db: D1Database): Promise<Response> {
  const { results: alerts } = await db.prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT 100").all<Row>();
  const { results: runs } = await db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 60").all<Row>();
  const body = [
    "<h2>Scheduled runs</h2>",
    table(["Time (UTC)", "Job", "Result", "Detail"], runs.map((r) => [esc(r.at), esc(r.job), r.ok ? "pass" : "FAIL", esc(r.detail)]), (i) => (runs[i].ok ? "" : "bad")),
    "<h2>Alerts</h2>",
    table(["Time (UTC)", "Kind", "Delivery", "Detail"], alerts.map((r) => [esc(r.at), esc(r.kind), esc(r.sent), esc(r.detail)]), (i) =>
      String(alerts[i].sent).startsWith("failed") ? "bad" : "",
    ),
  ].join("");
  return page("/health", "Health", body);
}

/** Values of `*_secret` keys are secret names; show whether each is set, never a value. */
function masked(value: unknown, env: Env, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => masked(v, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, masked(v, env, k)]));
  if (key.endsWith("_secret") && typeof value === "string") return `${value} (${secretsOf(env)(value) ? "set" : "missing"})`;
  return value;
}

export function dashboard(config: Config) {
  const verify = config.dashboard.access ? accessVerifier(config.dashboard.access.team_domain, config.dashboard.access.aud) : undefined;

  return async function serve(request: Request, env: Env): Promise<Response> {
    if (!verify && !config.dashboard.unprotected) return new Response("Not found", { status: 404 });
    if (!config.dashboard.unprotected && !(await verify!(request.headers.get("cf-access-jwt-assertion")))) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });

    const url = new URL(request.url);
    const raw = url.pathname.match(/^\/raw\/(\d+)$/);
    if (raw) {
      const row = await env.DB.prepare("SELECT r2_key FROM mail WHERE id = ?").bind(Number(raw[1])).first<{ r2_key: string | null }>();
      const object = row?.r2_key && env.RAW ? await env.RAW.get(row.r2_key) : null;
      if (!object) return new Response("Not retained", { status: 404 });
      return new Response(object.body, {
        headers: { "content-type": "message/rfc822", "content-disposition": `attachment; filename="mail-${raw[1]}.eml"`, "cache-control": "no-store" },
      });
    }
    switch (url.pathname) {
      case "/":
        return ledger(config, env.DB, url);
      case "/stats":
        return stats(env.DB);
      case "/health":
        return health(env.DB);
      case "/config":
        return page("/config", "Config", `<pre>${esc(JSON.stringify(masked(config, env), null, 2))}</pre>`);
      default:
        return new Response("Not found", { status: 404 });
    }
  };
}
