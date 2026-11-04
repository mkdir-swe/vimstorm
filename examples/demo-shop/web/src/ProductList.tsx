import type { Product } from "./api.ts";
import { formatPrice } from "./money.ts";

interface Props {
  products: Product[];
  onAdd: (productId: number) => void;
}

export function ProductList({ products, onAdd }: Props) {
  return (
    <ul className="products" aria-label="Products">
      {products.map((p) => (
        <li key={p.id} className="product" aria-label={p.name}>
          <h2>{p.name}</h2>
          <p className="description">{p.description}</p>
          <p className="price">{formatPrice(p.priceCents)}</p>
          <button type="button" onClick={() => onAdd(p.id)}>
            Add to cart
          </button>
        </li>
      ))}
    </ul>
  );
}
