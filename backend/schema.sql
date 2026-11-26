-- SP076 shop database (Cloudflare D1 / SQLite)
-- Apply with:  npx wrangler d1 execute sp076 --file=schema.sql          (local)
--              npx wrangler d1 execute sp076 --file=schema.sql --remote (live)

-- One row per hoodie number. A number is either free, held while someone is
-- in Stripe Checkout, or sold. Holds expire on their own (reserved_until).
CREATE TABLE IF NOT EXISTS editions (
  id             INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 100),
  status         TEXT    NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold')),
  reserved_until INTEGER,          -- unix seconds; a hold past this time counts as free
  hold_token     TEXT,             -- random id for this hold, used to cancel it
  session_id     TEXT,             -- Stripe Checkout session for this hold
  size           TEXT,
  ip_hash        TEXT              -- hashed visitor IP, to stop one person holding many numbers
);

-- One row per paid order. id is the Stripe Checkout session id, so a repeated
-- Stripe webhook can never create a second order.
CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,
  edition          INTEGER NOT NULL UNIQUE REFERENCES editions(id),
  size             TEXT    NOT NULL,
  email            TEXT,
  name             TEXT,
  phone            TEXT,
  address_json     TEXT,
  amount_total     INTEGER,        -- in cents
  currency         TEXT,
  created_at       INTEGER NOT NULL,
  reference        TEXT    NOT NULL, -- SP076-042-XXXX, shown to the customer and sent to Gelato
  gelato_order_id  TEXT,
  gelato_status    TEXT,
  gelato_error     TEXT,
  tracking_code    TEXT,
  tracking_url     TEXT,
  shipped_email_at INTEGER
);

-- All 100 numbers start free.
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
INSERT OR IGNORE INTO editions (id) SELECT i FROM n;
