// Ambil nominal transfer dari teks hasil OCR struk/bukti transfer.
// Dipindah dari routes/monthlyFee.js & routes/cron.js lama (aturannya sama).

function parseNumber(str) {
  const cleaned = str.replace(/(\.|,)00$/, "").replace(/[.,]/g, "");
  return parseInt(cleaned, 10);
}

function extractAmount(raw) {
  if (!raw) return null;
  const text = raw.replace(/\s+/g, " ");

  // 1. angka setelah "Rp" / "IDR"
  let candidates = [...text.matchAll(/(Rp|IDR)\s*([0-9.,]+)/gi)]
    .map((m) => parseNumber(m[2]))
    .filter((n) => !isNaN(n) && n >= 1000);

  // 2. angka setelah kata "nominal"
  if (candidates.length === 0) {
    candidates = [...text.matchAll(/nominal\s*([0-9.,]+)/gi)]
      .map((m) => parseNumber(m[1]))
      .filter((n) => !isNaN(n) && n >= 1000);
  }

  // 3. fallback: angka ≥ 4 digit, ambil terbesar kedua (yang terbesar biasanya nomor rekening/referensi)
  if (candidates.length === 0) {
    const nums = (text.match(/[0-9]{4,}/g) || []).map((n) => parseInt(n, 10)).filter((n) => n < 100000000);
    if (nums.length === 0) return null;
    nums.sort((a, b) => a - b);
    candidates = [nums.length === 1 ? nums[0] : nums[nums.length - 2]];
  }

  let amount = Math.max(...candidates);

  // biaya admin bank yang ikut tertulis (2.500 / 6.500)
  const last4 = String(amount).slice(-4);
  if (last4 === "2500") amount -= 2500;
  else if (last4 === "6500") amount -= 6500;

  return amount;
}

module.exports = { extractAmount };
