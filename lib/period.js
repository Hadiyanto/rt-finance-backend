// Periode iuran selalu string 'YYYY-MM', dihitung dalam zona waktu Asia/Jakarta.

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const jakartaMonth = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
});

function currentPeriod(now = new Date()) {
  const parts = Object.fromEntries(jakartaMonth.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}`;
}

const isPeriod = (value) => typeof value === "string" && PERIOD_RE.test(value);

function monthsOfYear(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

module.exports = { PERIOD_RE, currentPeriod, isPeriod, monthsOfYear };
