import { useEffect, useState } from "react";
import type { Product, ShopApi } from "./api.ts";
import { CartPanel } from "./CartPanel.tsx";
import { ProductList } from "./ProductList.tsx";
import { useCart } from "./useCart.ts";

export function App({ api }: { api: ShopApi }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const cart = useCart(api);

  useEffect(() => {
    api.products().then(setProducts, (e: unknown) => setLoadError(String(e)));
  }, [api]);

  const error = loadError ?? cart.error;
  return (
    <div className="shop">
      <header>
        <h1>Leaf &amp; Kettle</h1>
        <p>Loose-leaf tea and the things to brew it in.</p>
      </header>
      {error && (
        <p role="alert" className="error">
          Something went wrong: {error}
        </p>
      )}
      <main>
        <ProductList products={products} onAdd={cart.add} />
        <CartPanel cart={cart.cart} onStep={cart.step} onRemove={cart.remove} />
      </main>
    </div>
  );
}
