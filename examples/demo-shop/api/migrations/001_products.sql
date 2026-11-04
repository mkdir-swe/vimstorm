CREATE TABLE products (
  id          serial PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  stock       integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
