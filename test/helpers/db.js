// Database test terpisah (rt_finance_test), dibangun ulang dari db/migrations setiap kali test dijalankan.
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://rt:rt@localhost:5433/rt_finance_test";

function assertLocal(url) {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1"].includes(host)) {
    throw new Error(`TEST_DATABASE_URL harus localhost, bukan ${host}`);
  }
}

async function ensureDatabase() {
  assertLocal(TEST_DATABASE_URL);
  const target = new URL(TEST_DATABASE_URL);
  const dbName = target.pathname.slice(1);
  const admin = new URL(TEST_DATABASE_URL);
  admin.pathname = "/postgres";

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (rowCount === 0) {
    await client.query(`CREATE DATABASE "${dbName}"`);
  }
  await client.end();
}

function migrationUpSql(file) {
  const sql = fs.readFileSync(file, "utf8");
  const up = sql.split("-- migrate:down")[0];
  return up.replace("-- migrate:up", "");
}

async function resetSchema() {
  await ensureDatabase();
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");

  const dir = path.join(__dirname, "../../db/migrations");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await client.query(migrationUpSql(path.join(dir, file)));
  }
  await client.end();
}

module.exports = { TEST_DATABASE_URL, resetSchema };
