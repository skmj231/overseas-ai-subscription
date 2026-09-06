/* 진입점. 환경변수 → 의존성 조립 → 마이그레이션 → HTTP + 스케줄러. */
import { makeDb } from "./db.js";
import { makeCrypto } from "./crypto.js";
import { makeToss } from "./toss.js";
import { makeMailer } from "./mail.js";
import { makeService } from "./service.js";
import { makeApp } from "./app.js";

const env = process.env;
const log = console;
const db = makeDb(env.DATABASE_URL);
await db.migrate();
const crypto = makeCrypto(env);
const toss = makeToss(env);
const mail = makeMailer(env);
const service = makeService({ db, toss, mail, crypto, env, log });
const app = makeApp({ service, env, toss, db, log });

const port = Number(env.PORT || 8787);
app.listen(port, () => log.info(`donna-plus-api :${port} (${env.NODE_ENV || "development"}) toss=${String(env.TOSS_SECRET_KEY || "").slice(0, 8)}…`));

/* 스케줄러: 매시 정각 근처에 한 바퀴. 잠금으로 한 인스턴스만 돈다. */
async function runTick() {
  try {
    const ran = await db.withLock(7745001, async () => { const r = await service.tick(); log.info("tick", JSON.stringify(r)); });
    if (!ran) log.info("tick skipped (다른 인스턴스가 실행 중)");
  } catch (e) { log.error("tick failed", e); }
}
if (env.SCHEDULER !== "off") {
  setTimeout(runTick, 15000);
  setInterval(runTick, 60 * 60 * 1000);
}
process.on("SIGTERM", async () => { await db.end().catch(() => {}); process.exit(0); });
