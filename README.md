# RT Finance — Backend

API keuangan RT 001/016 Graha Mampang Mas: laporan iuran & THR dari warga (banyak rumah × banyak bulan dalam satu laporan), approval pengurus dengan bantuan OCR, laporan iuran, tunggakan, dan buku kas.

Frontend: [rt-finance-frontend](https://github.com/Hadiyanto/rt-finance-frontend).

## Teknologi

- Node.js 26, Express 5, `pg` (SQL langsung, tanpa ORM), zod, express-rate-limit
- PostgreSQL 17, migrasi SQL dengan [dbmate](https://github.com/amacneil/dbmate)
- Tesseract.js (OCR bukti transfer), Cloudinary (penyimpanan bukti)
- Test: `node:test` terhadap database test sungguhan

## Menjalankan di lokal

```bash
npm install
cp .env.example .env               # isi JWT_SECRET & Cloudinary
scripts/db-reset-local.sh          # Postgres Docker :5433 + data dari backup produksi
npm run dev                        # http://localhost:3031
```

`scripts/db-reset-local.sh` (aman diulang) melakukan:

1. restore backup produksi terbaru (`~/backups/rt-finance/*.dump`) ke schema `legacy`;
2. menjalankan migrasi v2 (`db/migrations`) ke schema `public`;
3. migrasi data lama → v2 (`scripts/migrate-legacy.sql`, termasuk koreksi bendahara; batal otomatis kalau rekonsiliasi tidak cocok);
4. mencatat iuran Des 2025 s/d bulan lalu + THR 2026 ke kas (`scripts/backfill-fee-snapshots.js`);
5. seed kas dari rekening koran 2026 (`scripts/seed-ledger-rekap-2026.sql`, status PENDING);
6. membuat admin lokal `dev@local.test` / `rahasia123`.

Laporan perbandingan data lama vs v2: `psql postgres://rt:rt@localhost:5433/rt_finance -f scripts/reconcile.sql`.

Migrasi manual: `docker compose -f docker-compose.dev.yml run --rm migrate [up|rollback|status|new <nama>]`.

## Test

```bash
npm test
```

Memakai database `rt_finance_test` di Postgres lokal (dibuat & di-migrate ulang otomatis setiap run). Override dengan `TEST_DATABASE_URL` (harus localhost).

## Struktur

| Path | Isi |
|---|---|
| `index.js` / `app.js` | Start server + jadwal OCR / definisi Express app |
| `routes/public.js` | API warga tanpa login (`/api/public/*`), rate limited, tanpa data pribadi |
| `routes/auth.js` | Login & sesi pengurus (`/api/auth/*`) |
| `routes/admin.js` | API pengurus (`/api/admin/*`, role admin/bendahara) |
| `repositories/` | Query SQL per domain: rumah, pembayaran, review, laporan, kas |
| `services/ocr.js` | OCR bukti transfer laporan PENDING → WAITING_APPROVAL |
| `lib/` | Koneksi DB, auth (JWT), error, periode (Asia/Jakarta), parser nominal OCR |
| `db/migrations/` | Skema v2 (dbmate) |
| `scripts/` | Reset DB lokal, migrasi data lama, backfill kas, seed rekening koran, rekonsiliasi |
| `test/` | Test API (`node:test`) + fixtures |

## Konsep data

- **Rumah** (`house`) adalah unit yang ditagih. Kondisi rumah (dihuni/kosong, nama, HP) dicatat sebagai riwayat di `house_occupancy`; kondisi terkini lewat view `v_house_current`.
- **Tarif** (`fee_plan` + komponen) berlaku per rumah mulai periode tertentu (`house_fee_plan`). Rumah kosong = `KEAMANAN_100`.
- **Laporan** (`payment`) = 1 bukti transfer; isinya banyak `payment_item` (1 rumah × 1 bulan, atau THR per tahun). Nominal per bulan dihitung server dari tarif. Satu rumah hanya boleh 1 item aktif per bulan; laporan yang ditolak membuka bulannya lagi.
- **Periode** selalu teks `YYYY-MM` (zona Asia/Jakarta), bukan timestamp.
- **Kas** (`ledger_entry`): pemasukan/pengeluaran manual (perlu approve), ditambah pencatatan otomatis dari tombol **Iuran**:
  - iuran sebulan → 4 pos (Kas + Agama RT, Sampah, Keamanan + Agama RW + Kas RW, KKM RW); 3 pos terakhir otomatis diikuti pengeluaran setoran ke RW/yayasan;
  - THR setahun → pemasukan THR + setoran THR ke RW;
  - bisa diulang: hanya selisih (pembayaran telat) yang ditambahkan sebagai susulan.
- **Iuran mengendap** = iuran disetujui yang belum tercatat di kas (`GET /api/public/ledger/held-fees`).

## API ringkas

Publik: `GET /api/public/houses`, `GET /api/public/house-periods`, `POST /api/public/payments/quote`, `POST /api/public/payments`, `POST /api/public/thr`, `POST /api/public/upload-proof`, `GET /api/public/reports/fee-breakdown`, `GET /api/public/thr/recap`, `GET /api/public/ledger`, `GET /api/public/ledger/categories`, `GET /api/public/ledger/held-fees`.

Pengurus: `POST /api/auth/login`, `GET /api/auth/me`, `GET|POST /api/admin/payments[/:id/approve|reject]`, `GET /api/admin/arrears`, `GET|POST /api/admin/ledger[/:id/approve|reject]`, `GET|POST /api/admin/ledger/fee-snapshot`, `GET|POST /api/admin/ledger/thr-snapshot`, `POST /api/admin/ocr/run`.

## Deploy (VPS)

Dikelola dari repo [setupvps](https://github.com/Hadiyanto/setupvps) (proyek `rt`): nginx, env terenkripsi, Postgres bersama, dan `05-up.sh rt`. Di repo ini:

- `Dockerfile` + `docker-compose.yml` — container `rt-finance-backend` di port `127.0.0.1:6001`, network `backend` (Postgres bersama `shared-postgres`), volume cache data OCR.
- Migrasi: `docker exec rt-finance-backend npm run migrate up` (dbmate).
- Cutover dari Supabase: lihat `docs/rt-finance.md` di repo setupvps.

## Environment

Lihat [`.env.example`](.env.example). Di luar `NODE_ENV=production`, koneksi ke database selain localhost ditolak (hindari menulis ke DB produksi tanpa sengaja); set `ALLOW_REMOTE_DB=1` kalau memang perlu.
