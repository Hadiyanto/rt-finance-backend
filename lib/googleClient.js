const { google } = require("googleapis");

function getGoogleSheets() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error("Missing env GOOGLE_SERVICE_ACCOUNT_JSON");
  }

  const credentials = JSON.parse(raw);

  // Fix newline
  credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

module.exports = getGoogleSheets;
