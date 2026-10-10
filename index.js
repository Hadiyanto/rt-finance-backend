require("dotenv").config({ quiet: true });

const cron = require("node-cron");
const app = require("./app");
const { runOcrBatch } = require("./services/ocr");

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// OCR bukti transfer setiap 5 menit (batch kecil). Matikan dengan OCR_CRON_ENABLED=0.
if (process.env.OCR_CRON_ENABLED !== "0") {
  cron.schedule("*/5 * * * *", () => {
    runOcrBatch()
      .then((r) => r.processed + r.failed > 0 && console.log("OCR batch:", r))
      .catch((err) => console.error("OCR batch error:", err));
  });
}
