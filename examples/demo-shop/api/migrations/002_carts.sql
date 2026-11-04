CREATE TABLE carts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
  cart_id    uuid NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  quantity   integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, product_id)
);
