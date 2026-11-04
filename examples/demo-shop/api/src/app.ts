import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type pg from "pg";
import { cartTotal, lineTotal, MAX_QUANTITY, type CartLine } from "./cart.ts";
import { Store, type Outcome, type Refusal } from "./store.ts";
import type { CartView, ErrorView } from "./views.ts";

export interface AppOptions {
  pool: pg.Pool;
  logger?: boolean;
}

const cartParams = {
  type: "object",
  required: ["cartId"],
  properties: { cartId: { type: "string", format: "uuid" } },
} as const;

const itemParams = {
  type: "object",
  required: ["cartId", "productId"],
  properties: {
    cartId: { type: "string", format: "uuid" },
    productId: { type: "integer", minimum: 1 },
  },
} as const;

interface CartParams {
  cartId: string;
}
interface ItemParams extends CartParams {
  productId: number;
}

const STATUS: Record<Refusal, number> = {
  "cart-not-found": 404,
  "product-not-found": 404,
  "quantity-limit": 409,
};

function view(id: string, lines: CartLine[]): CartView {
  return {
    id,
    lines: lines.map((line) => ({ ...line, lineTotalCents: lineTotal(line) })),
    totalCents: cartTotal(lines),
  };
}

export function buildApp({ pool, logger = false }: AppOptions): FastifyInstance {
  const app = Fastify({ logger });
  const store = new Store(pool);

  const refuse = (reply: FastifyReply, refusal: Refusal) => {
    const body: ErrorView = { error: refusal };
    return reply.code(STATUS[refusal]).send(body);
  };

  /** The cart as it is now, or its refusal. */
  const answer = async (reply: FastifyReply, cartId: string, outcome: Outcome = { ok: true }) => {
    if (!outcome.ok) return refuse(reply, outcome.refusal);
    const lines = await store.lines(cartId);
    if (!lines) return refuse(reply, "cart-not-found");
    return reply.send(view(cartId, lines));
  };

  app.get("/api/health", async () => {
    await store.ping();
    return { ok: true };
  });

  app.get("/api/products", async () => store.products());

  app.post("/api/carts", async (_request, reply) => {
    const id = await store.createCart();
    return reply.code(201).send(view(id, []));
  });

  app.get<{ Params: CartParams }>(
    "/api/carts/:cartId",
    { schema: { params: cartParams } },
    async (request, reply) => answer(reply, request.params.cartId),
  );

  app.post<{ Params: CartParams; Body: { productId: number; quantity?: number } }>(
    "/api/carts/:cartId/items",
    {
      schema: {
        params: cartParams,
        body: {
          type: "object",
          required: ["productId"],
          additionalProperties: false,
          properties: {
            productId: { type: "integer", minimum: 1 },
            quantity: { type: "integer", minimum: 1, maximum: MAX_QUANTITY },
          },
        },
      },
    },
    async (request, reply) => {
      const { cartId } = request.params;
      const { productId, quantity = 1 } = request.body;
      return answer(reply, cartId, await store.add(cartId, productId, quantity));
    },
  );

  app.put<{ Params: ItemParams; Body: { quantity: number } }>(
    "/api/carts/:cartId/items/:productId",
    {
      schema: {
        params: itemParams,
        body: {
          type: "object",
          required: ["quantity"],
          additionalProperties: false,
          properties: { quantity: { type: "integer", minimum: 0, maximum: MAX_QUANTITY } },
        },
      },
    },
    async (request, reply) => {
      const { cartId, productId } = request.params;
      return answer(reply, cartId, await store.set(cartId, productId, request.body.quantity));
    },
  );

  app.delete<{ Params: ItemParams }>(
    "/api/carts/:cartId/items/:productId",
    { schema: { params: itemParams } },
    async (request, reply) => {
      const { cartId, productId } = request.params;
      return answer(reply, cartId, await store.remove(cartId, productId));
    },
  );

  return app;
}
