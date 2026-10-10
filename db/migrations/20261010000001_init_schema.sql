-- migrate:up

-- Periode iuran selalu teks 'YYYY-MM' (bukan timestamp) agar bebas bug timezone.
CREATE DOMAIN period_month AS char(7) CHECK (VALUE ~ '^\d{4}-(0[1-9]|1[0-2])$');

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- === Master ===

CREATE TABLE app_user (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'bendahara', 'rt')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Rumah = unit yang ditagih. Riwayat bayar melekat ke rumah, bukan ke orang.
-- Kondisi rumah (dihuni/kosong, nama, HP) ada di house_occupancy; kondisi terkini lewat v_house_current.
CREATE TABLE house (
  id         serial PRIMARY KEY,
  block      text NOT NULL,
  number     text NOT NULL,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (block, number)
);

-- Riwayat kondisi rumah. Setiap perubahan (kosong, terisi lagi, ganti pemilik/penghuni) = baris baru,
-- baris lama tidak diubah, supaya bisa dijawab "sejak kapan kosong, siapa yang mencatat".
CREATE TABLE house_occupancy (
  id             serial PRIMARY KEY,
  house_id       int          NOT NULL REFERENCES house (id),
  start_period   period_month NOT NULL,
  status         text NOT NULL CHECK (status IN ('OCCUPIED', 'VACANT')),
  resident_name  text,         -- penghuni, atau pemilik kalau rumah kosong; label & prefill "Nama Pelapor"
  phone          text,         -- tidak pernah dikirim ke endpoint publik
  occupancy_type text CHECK (occupancy_type IN ('OWNER', 'TENANT')),
  notes          text,         -- mis. 'ganti pemilik'
  recorded_by    int REFERENCES app_user (id),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (house_id, start_period)
);

-- === Tarif ===

CREATE TABLE fee_plan (
  id           serial PRIMARY KEY,
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  total_amount int  NOT NULL CHECK (total_amount > 0),
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE fee_plan_component (
  fee_plan_id int  NOT NULL REFERENCES fee_plan (id),
  component   text NOT NULL CHECK (component IN ('KAS_RT', 'AGAMA_RT', 'SAMPAH', 'KEAMANAN', 'AGAMA_RW', 'KAS_RW', 'KKM_RW')),
  amount      int  NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (fee_plan_id, component)
);

-- Tarif per rumah mulai periode tertentu. Baris paling awal = rumah mulai ditagih (dasar penanda tunggakan).
-- fee_plan_id NULL = pada periode itu rumah tidak ditagih (kosong / belum dihuni).
CREATE TABLE house_fee_plan (
  house_id     int          NOT NULL REFERENCES house (id),
  start_period period_month NOT NULL,
  fee_plan_id  int          REFERENCES fee_plan (id),
  PRIMARY KEY (house_id, start_period)
);

-- === Pembayaran ===

-- 1 baris = 1 laporan (1 bukti transfer), berapa pun jumlah rumah/bulannya.
CREATE TABLE payment (
  id              serial PRIMARY KEY,
  payer_name      text NOT NULL,                               -- "Nama Pelapor" (snapshot)
  paid_at         date NOT NULL DEFAULT current_date,
  method          text NOT NULL DEFAULT 'TRANSFER' CHECK (method IN ('TRANSFER', 'CASH')),
  reported_amount int  NOT NULL CHECK (reported_amount > 0),   -- isian warga; nominal seharusnya = SUM(payment_item.amount)
  proof_url       text,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'WAITING_APPROVAL', 'WAITING_MANUAL_INPUT', 'APPROVED', 'REJECTED')),
  ocr_text        text,
  ocr_amount      int,
  ocr_attempts    int  NOT NULL DEFAULT 0,
  ocr_error       text,
  notes           text,
  submitted_by    int REFERENCES app_user (id),                -- NULL = form publik warga
  reviewed_by     int REFERENCES app_user (id),                -- admin yang menyetujui/menolak
  reviewed_at     timestamptz,
  reject_reason   text,
  legacy_ref      text,                                        -- jejak migrasi, mis. 'MonthlyFee:123'
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_status_idx ON payment (status);
CREATE INDEX payment_paid_at_idx ON payment (paid_at);

CREATE TABLE rw_submission (
  id           serial PRIMARY KEY,
  period       period_month NOT NULL,
  total_amount int NOT NULL,
  submitted_at timestamptz NOT NULL,
  submitted_by int REFERENCES app_user (id),
  notes        text,
  legacy_ref   text
);

-- 1 item = 1 rumah × 1 periode.
CREATE TABLE payment_item (
  id               serial PRIMARY KEY,
  payment_id       int  NOT NULL REFERENCES payment (id),
  house_id         int  NOT NULL REFERENCES house (id),
  kind             text NOT NULL CHECK (kind IN ('MONTHLY_FEE', 'THR')),
  period           text NOT NULL,                       -- 'YYYY-MM' (iuran) / 'YYYY' (THR)
  fee_plan_id      int  REFERENCES fee_plan (id),       -- NULL untuk THR
  amount           int  NOT NULL CHECK (amount > 0),    -- snapshot tarif saat lapor; admin boleh koreksi
  rw_submission_id int  REFERENCES rw_submission (id),
  voided_at        timestamptz,                         -- diisi saat payment REJECTED
  CHECK ((kind = 'MONTHLY_FEE' AND period ~ '^\d{4}-(0[1-9]|1[0-2])$' AND fee_plan_id IS NOT NULL)
      OR (kind = 'THR' AND period ~ '^\d{4}$'))
);
-- 1 rumah hanya boleh punya 1 item aktif per jenis per periode → mencegah lapor dobel.
CREATE UNIQUE INDEX payment_item_active_uniq ON payment_item (house_id, kind, period) WHERE voided_at IS NULL;
CREATE INDEX payment_item_payment_idx ON payment_item (payment_id);
CREATE INDEX payment_item_period_idx ON payment_item (period);

-- === Kas ===

CREATE TABLE ledger_category (
  id        serial PRIMARY KEY,
  name      text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  UNIQUE (name, direction)
);

CREATE TABLE ledger_entry (
  id          serial PRIMARY KEY,
  entry_date  date NOT NULL,
  direction   text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  amount      int  NOT NULL CHECK (amount > 0),
  category_id int  NOT NULL REFERENCES ledger_category (id),
  description text,
  proof_url   text,
  status      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  ref_type    text CHECK (ref_type IN ('PAYMENT', 'RW_SUBMISSION')),
  ref_id      int,
  created_by  int REFERENCES app_user (id),
  approved_by int REFERENCES app_user (id),
  approved_at timestamptz,
  legacy_ref  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entry_date_idx ON ledger_entry (entry_date);

-- === Telegram ===

CREATE TABLE telegram_chat (
  chat_id    bigint PRIMARY KEY,
  user_id    int REFERENCES app_user (id),
  is_allowed boolean NOT NULL DEFAULT false
);

-- === updated_at otomatis ===

CREATE TRIGGER app_user_updated_at     BEFORE UPDATE ON app_user     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER house_updated_at        BEFORE UPDATE ON house        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payment_updated_at      BEFORE UPDATE ON payment      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ledger_entry_updated_at BEFORE UPDATE ON ledger_entry FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- === View ===

-- Kondisi terkini per rumah = baris house_occupancy terakhir yang sudah berlaku.
CREATE VIEW v_house_current AS
SELECT h.id, h.block, h.number, h.notes,
       o.status, o.resident_name, o.phone, o.occupancy_type, o.start_period AS status_since
FROM house h
LEFT JOIN LATERAL (
  SELECT ho.*
  FROM house_occupancy ho
  WHERE ho.house_id = h.id AND ho.start_period <= to_char(now() AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM')
  ORDER BY ho.start_period DESC
  LIMIT 1
) o ON true;

-- Iuran bulanan yang aktif (belum di-void) per rumah per periode; sumber laporan & grid status.
CREATE VIEW v_house_period_status AS
SELECT pi.house_id, pi.period, pi.amount, pi.fee_plan_id, pi.rw_submission_id,
       p.id AS payment_id, p.status
FROM payment_item pi
JOIN payment p ON p.id = pi.payment_id
WHERE pi.kind = 'MONTHLY_FEE' AND pi.voided_at IS NULL;

-- migrate:down

DROP VIEW v_house_period_status;
DROP VIEW v_house_current;
DROP TABLE telegram_chat;
DROP TABLE ledger_entry;
DROP TABLE ledger_category;
DROP TABLE payment_item;
DROP TABLE rw_submission;
DROP TABLE payment;
DROP TABLE house_fee_plan;
DROP TABLE fee_plan_component;
DROP TABLE fee_plan;
DROP TABLE house_occupancy;
DROP TABLE house;
DROP TABLE app_user;
DROP FUNCTION set_updated_at();
DROP DOMAIN period_month;
