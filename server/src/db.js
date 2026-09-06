import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export function makeDb(DATABASE_URL) {
  if (!DATABASE_URL) throw new Error("DATABASE_URL이 없습니다.");
  const ssl = /localhost|127\.0\.0\.1|\/tmp/.test(DATABASE_URL) ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl, max: 5 });
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;

  async function migrate() {
    const dir = path.join(here, "..", "sql");
    for (const f of readdirSync(dir).filter(x => x.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(path.join(dir, f), "utf8"));
    }
  }
  /* 한 프로세스만 스케줄러를 돌리게 하는 잠금(Railway가 잠깐 두 인스턴스를 띄울 때 대비). */
  async function withLock(key, fn) {
    const c = await pool.connect();
    try {
      const r = await c.query("SELECT pg_try_advisory_lock($1) AS ok", [key]);
      if (!r.rows[0].ok) return false;
      try { await fn(c); } finally { await c.query("SELECT pg_advisory_unlock($1)", [key]); }
      return true;
    } finally { c.release(); }
  }
  async function tx(fn) {
    const c = await pool.connect();
    try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
    catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
    finally { c.release(); }
  }
  return { pool, q, one, tx, migrate, withLock, end: () => pool.end() };
}
