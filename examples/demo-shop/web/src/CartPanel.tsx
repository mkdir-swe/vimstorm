import type { Cart } from "./api.ts";
import { formatPrice } from "./money.ts";

interface Props {
  cart: Cart | undefined;
  onStep: (productId: number, delta: number) => void;
  onRemove: (productId: number) => void;
}

export function CartPanel({ cart, onStep, onRemove }: Props) {
  if (!cart) return <aside className="cart">Loading cart…</aside>;
  return (
    <aside className="cart" aria-label="Cart">
      <h2>Cart</h2>
      {cart.lines.length === 0 ? (
        <p className="empty">Your cart is empty.</p>
      ) : (
        <ul>
          {cart.lines.map((line) => (
            <li key={line.productId} className="line" aria-label={line.name}>
              <span className="name">{line.name}</span>
              <span className="quantity">
                <button
                  type="button"
                  aria-label={`One less ${line.name}`}
                  onClick={() => onStep(line.productId, -1)}
                >
                  −
                </button>
                <output aria-label="Quantity">{line.quantity}</output>
                <button
                  type="button"
                  aria-label={`One more ${line.name}`}
                  onClick={() => onStep(line.productId, 1)}
                >
                  +
                </button>
              </span>
              <span className="line-total">{formatPrice(line.lineTotalCents)}</span>
              <button
                type="button"
                className="remove"
                aria-label={`Remove ${line.name}`}
                onClick={() => onRemove(line.productId)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="total">
        Total <strong data-testid="cart-total">{formatPrice(cart.totalCents)}</strong>
      </p>
    </aside>
  );
}
