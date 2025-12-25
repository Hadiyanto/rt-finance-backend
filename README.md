# RT Finance Backend

Backend service untuk aplikasi RT Finance, bertugas menangani manajemen warga, iuran bulanan (termasuk OCR), dan laporan keuangan.

## 🚀 Fitur Utama

*   **Manajemen Warga**: CRUD data warga per blok dan nomor rumah.
*   **Iuran Bulanan**: Input manual atau **Otomatis via OCR** (struk transfer).
*   **Laporan Keuangan**: Breakdown pemasukan bulanan real-time.
*   **Performance**: Mendukung caching Redis untuk respon cepat dan indexing database.

## 🛠️ Teknologi

*   **Runtime**: Node.js (Express.js)
*   **Database**: PostgreSQL (via Neon)
*   **ORM**: Prisma
*   **Cache**: Redis (via Upstash)
*   **OCR**: Tesseract.js
*   **Storage**: Cloudinary

## 📋 Prasyarat

Pastikan Anda telah menginstall:
*   [Node.js](https://nodejs.org/) (v18+)
*   Database PostgreSQL
*   Akun Upstash (untuk Redis)
*   Akun Cloudinary

## ⚙️ Instalasi

1.  **Clone repository**
    ```bash
    git clone <repo-url>
    cd rt-finance-backend
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

3.  **Setup Environment Variables**
    Buat file `.env` dan isi konfigurasi berikut:

    ```env
    # App
    PORT=3000
    NODE_ENV=development

    # Database (Prisma)
    DATABASE_URL="postgresql://user:password@host:port/db?sslmode=require"

    # Redis (Upstash) - Wajib untuk Caching
    UPSTASH_REDIS_REST_URL="https://your-upstash-url.upstash.io"
    UPSTASH_REDIS_REST_TOKEN="your-upstash-token"

    # Caching Versioning
    # Ubah versi ini (misal ke v2) untuk memaksa refresh cache daftar warga di semua client
    RESIDENT_CACHE_VERSION="v1" 

    # Cloudinary (Upload Gambar)
    CLOUDINARY_CLOUD_NAME="your-cloud-name"
    CLOUDINARY_API_KEY="your-api-key"
    CLOUDINARY_API_SECRET="your-api-secret"

    # Security
    # Digunakan untuk validasi request dari cron job
    CRON_SECRET="your-secret-key"
    ```

4.  **Database Migration**
    ```bash
    npx prisma migrate dev
    ```

5.  **Jalankan Aplikasi**
    ```bash
    node index.js
    ```
    Server akan berjalan di `http://localhost:3000`

## ⚡ Optimasi Performa

Backend ini telah dioptimasi untuk menangani ribuan data dengan cepat:

1.  **Database Indexing**:
    Kolom `date` pada tabel `MonthlyFee` telah di-index untuk mempercepat query laporan bulanan.

2.  **Smart Caching (Redis)**:
    *   **Laporan Bulanan (`/monthly-fee/breakdown`)**:
        *   Bulan berjalan: Cache 1 jam (untuk menyeimbangkan beban server vs update data).
        *   Bulan lalu: Cache 24 jam.
        *   *Auto-Invalidation*: Cache otomatis dihapus saat ada input iuran baru.
    *   **Daftar Blok (`/block-houses`)**:
        *   Cache 30 hari (karena struktur blok jarang berubah).
    *   **Daftar Warga**:
        *   Menggunakan `RESIDENT_CACHE_VERSION`. Jika ada perubahan logika di backend, cukup ganti versi di `.env` untuk mereset cache user.

## 📂 Struktur Project

*   `prisma/` - Schema database & migrasi.
*   `routes/` - Definisi API endpoints.
*   `middlewares/` - Auth & Caching logic.
*   `lib/` - Helper clients (Prisma, Redis).
*   `config/` - Konfigurasi 3rd party services.

## 🤖 Cron Jobs

Aplikasi ini memiliki endpoint khusus untuk Cron Job (misal: trigger OCR otomatis):
*   `POST /api/cron/run-ocr`
*   `POST /api/cron/release-deferred-v1/:date`

Pastikan header `x-cron-secret` dikirim sesuai dengan `.env`.