// Setup bersama: DB test bersih + fixtures sebelum setiap test, server di port acak.
const { before, beforeEach, after } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { TEST_DATABASE_URL, resetSchema } = require("./db");

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
delete process.env.CLOUDINARY_CLOUD_NAME;

const app = require("../../app");
const db = require("../../lib/db");

const FIXTURES = fs.readFileSync(path.join(__dirname, "../fixtures.sql"), "utf8");
const PASSWORD = "rahasia123";

function useTestServer() {
  const ctx = { db };

  before(async () => {
    await resetSchema();
    ctx.server = app.listen(0);
    ctx.baseUrl = `http://127.0.0.1:${ctx.server.address().port}`;
  });

  beforeEach(async () => {
    await db.query(FIXTURES);
  });

  after(async () => {
    ctx.server.close();
    await db.pool.end();
  });

  ctx.api = async (method, url, body, token) => {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(ctx.baseUrl + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };

  ctx.login = async (email = "bendahara@rt.test") => {
    const { body } = await ctx.api("POST", "/api/auth/login", { email, password: PASSWORD });
    return body.token;
  };

  return ctx;
}

module.exports = { useTestServer, PASSWORD };
