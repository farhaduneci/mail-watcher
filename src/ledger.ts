// The D1 ledger (migrations/): one row per email. Holds redacted summaries and fields only;
// revealed values never reach it.

export interface MailRow {
  at: string;
  to_addr: string;
  tag: string;
  from_addr: string;
  subject: string;
  message_id: string | null;
  watch: string | null;
  category: string;
  confidence: number | null;
  probs: string | null;
  action: string;
  forwarded_to: string | null;
  fields: string | null;
  summary: string | null;
  notified: string | null;
  error: string | null;
  r2_key: string | null;
}

export async function insertRow(db: D1Database, row: MailRow): Promise<void> {
  const cols = Object.keys(row) as (keyof MailRow)[];
  await db
    .prepare(`INSERT INTO mail (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
}

export async function recordRun(db: D1Database, job: "selftest" | "digest", ok: boolean, detail: string, at = new Date()): Promise<void> {
  await db.prepare("INSERT INTO runs (at, job, ok, detail) VALUES (?, ?, ?, ?)").bind(at.toISOString(), job, ok ? 1 : 0, detail).run();
}
