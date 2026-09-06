import { makeDb } from "./db.js";
const db = makeDb(process.env.DATABASE_URL);
await db.migrate(); console.log("migrated"); await db.end();
