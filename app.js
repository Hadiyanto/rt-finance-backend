const express = require("express");
const cors = require("cors");
const db = require("./lib/db");
const { errorHandler } = require("./lib/errors");

const app = express();

// di belakang reverse proxy (nginx/Cloudflare) agar IP asli klien terbaca untuk rate limit
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));

const corsOrigins = (process.env.CORS_ORIGINS || "http://localhost:3030")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({ origin: corsOrigins, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }));
app.use(express.json({ limit: "100kb" }));

app.get("/health", async (req, res) => {
  await db.query("SELECT 1");
  res.json({ status: "ok" });
});

app.use("/api/public", require("./routes/public"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));

app.use((req, res) => {
  res.status(404).json({ code: "NOT_FOUND", message: "Endpoint tidak ditemukan" });
});

app.use(errorHandler);

module.exports = app;
