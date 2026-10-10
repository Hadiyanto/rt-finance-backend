const { Pool, types } = require("pg");

// DATE (oid 1082) tetap string 'YYYY-MM-DD', jangan diubah ke Date lokal → hindari bug timezone.
types.setTypeParser(1082, (v) => v);
// COUNT/SUM (int8, oid 20): nominal rupiah RT jauh di bawah 2^53, aman jadi number.
types.setTypeParser(20, (v) => parseInt(v, 10));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL belum diset");
}

// Selama transisi .env lokal masih bisa menunjuk ke Supabase produksi; tolak koneksi remote di luar production.
const host = new URL(connectionString).hostname;
const isLocalHost = ["localhost", "127.0.0.1", "db"].includes(host);
if (!isLocalHost && process.env.NODE_ENV !== "production" && process.env.ALLOW_REMOTE_DB !== "1") {
  throw new Error(`DATABASE_URL menunjuk ke host remote (${host}). Set ALLOW_REMOTE_DB=1 kalau memang disengaja.`);
}

const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX || 10),
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: true } : undefined,
});

pool.on("error", (err) => {
  console.error("Postgres pool error:", err);
});

const query = (text, params) => pool.query(text, params);

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const isUniqueViolation = (err) => err && err.code === "23505";

module.exports = { pool, query, withTransaction, isUniqueViolation };
