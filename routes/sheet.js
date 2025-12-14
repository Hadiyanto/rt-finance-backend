// routes/sheet.js
const express = require("express");
const { getGoogleSheets } = require("../lib/googleClient.js");

const router = express.Router();

// ==============================
// GET /sheet/read
// ==============================
router.get("/sheet/read", async (req, res) => {
  try {
    const sheets = getGoogleSheets();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A1:Z500", // bisa ubah range
    });

    res.json({
      success: true,
      rows: response.data.values || [],
    });
  } catch (err) {
    console.error("Sheet read error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to read Google Sheet",
    });
  }
});

// ==============================
// POST /sheet/add
// ==============================
// Body:
// { "values": ["A1", "1", "Nama", "occupied"] }
router.post("/sheet/add", async (req, res) => {
  try {
    const sheets = getGoogleSheets();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    const { values } = req.body;

    if (!values || !Array.isArray(values)) {
      return res.status(400).json({
        success: false,
        message: "Body must contain: { values: [] }",
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      requestBody: {
        values: [values],
      },
    });

    res.json({ success: true, message: "Row appended" });
  } catch (err) {
    console.error("Sheet add error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to append data",
    });
  }
});

module.exports = router;
