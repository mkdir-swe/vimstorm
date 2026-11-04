# demo-shop

Leaf & Kettle is a small tea shop with a product list and a cart. The front end is React on Vite,
the API is Node with Fastify, the database is Postgres, and it's TypeScript throughout. It's
VimStorm's demo app. `abe demo new` makes your own private copy on GitHub, with three cards as
its issues: a feature, a bug and a chore.

```sh
docker run -d --name shop-pg -e POSTGRES_USER=shop -e POSTGRES_PASSWORD=shop -p 5432:5432 postgres:17-alpine
export DATABASE_URL=postgres://shop:shop@localhost:5432/shop
npm ci
npm run seed                 # migrations, then the catalogue
npm run dev -w api           # the API on http://127.0.0.1:3001
npm run dev -w web           # the shop on http://localhost:5173
npm test && npm run typecheck && npm run lint
```

- `API_PORT` and `WEB_PORT` move the API and the front end; the front end sends `/api` to the API.
- The API tests need Postgres too, through `DATABASE_URL`, or `TEST_DATABASE_URL` for another
  database. Each test file gets a schema of its own.
- `npm run migrate` applies the migrations in `api/migrations` and nothing else.
