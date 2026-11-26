# SP076 shop backend

One Cloudflare Worker that sells the 100 numbered hoodies and sends each paid order to Gelato for printing.

```
shop page ──► Worker ──► holds the number (D1 database, 30 min)
                    ──► Stripe Checkout (customer pays, gives address)
Stripe ──"paid"──► Worker ──► marks it sold ──► Gelato order with that number's print files (from R2)
Gelato ──"shipped"──► Worker ──► stores tracking ──► emails the customer (optional)
```

Running costs while selling: Cloudflare free tier, no monthly fees. You pay Stripe's fee per sale
and Gelato's price per hoodie.

## What it guarantees

- **A number is sold once.** It is held in one atomic database step before payment. The hold lasts
  32 minutes and Stripe's checkout closes after 31, so a payment can never land on a number someone
  else has. Cancelling on Stripe's page frees the number straight away; abandoned checkouts free it
  when Stripe expires them.
- **One visitor can hold at most 2 numbers at a time**, so nobody can block the whole run.
- **Repeated webhooks are harmless.** Orders are keyed by the Stripe session; Gelato is only called
  if the order has no Gelato id yet, and a failed Gelato call makes Stripe retry later.
- **Print files stay private.** They live in a private R2 bucket. Gelato gets links that are signed
  and stop working after 14 days.
- **Nothing is printed by accident.** `GELATO_ORDER_TYPE = "draft"` until you change it to `"order"`.

## One-time setup

You need accounts at Cloudflare (free), Stripe and Gelato. Run these in `backend/`.

1. Install the tools: `npm install`
2. Log in to Cloudflare: `npx wrangler login`
3. Create the database: `npx wrangler d1 create sp076`. Copy the `database_id` it prints into
   `wrangler.toml`. Then: `npm run db:remote`
4. Create the print bucket: `npx wrangler r2 bucket create sp076-prints`. Then upload the 200 files:
   `npm run upload-prints`
5. Add the secrets (each command asks for the value):
   ```
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   npx wrangler secret put GELATO_API_KEY
   npx wrangler secret put GELATO_WEBHOOK_TOKEN
   npx wrangler secret put FILE_SIGNING_SECRET
   npx wrangler secret put IP_SALT
   ```
   Make up long random strings for the last three. `.dev.vars.example` says where each key comes from.
6. Choose the hoodie in Gelato's catalogue and paste its product UID for each size into
   `GELATO_PRODUCTS` in `wrangler.toml`. Check the product's print areas: if the front isn't called
   `default`, change `GELATO_FRONT_FILE_TYPE`. Also check that the print files' sizes (12 cm front,
   30 cm back) fit its print areas.
7. Deploy: `npm run deploy`. Put the address it prints into `WORKER_URL` in `wrangler.toml` and
   deploy again.
8. Stripe → Developers → Webhooks → add endpoint `https://<worker>/api/stripe/webhook` with the events
   `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`.
   Copy its signing secret into `STRIPE_WEBHOOK_SECRET` (step 5).
9. Gelato → Developer → Webhooks → add `https://<worker>/api/gelato/webhook?token=<GELATO_WEBHOOK_TOKEN>`
   for order status and tracking updates.
10. Point the shop page at the Worker. In `index.html`, set
    `<meta name="sp076-api" content="https://<worker>">`. With it empty the page stays a demo and
    charges nothing.

## Testing before going live

- Use Stripe **test keys** (`sk_test_…`) and pay with card `4242 4242 4242 4242`.
- Keep `GELATO_ORDER_TYPE = "draft"`: orders appear in Gelato's dashboard but nothing is produced or charged.
- Locally:
  1. `cp .dev.vars.example .dev.vars` and fill it in.
  2. `npm run db:local`, then `npm run upload-prints -- --local`.
  3. `npm run dev` (Worker on http://localhost:8787).
  4. `stripe listen --forward-to localhost:8787/api/stripe/webhook` (Stripe CLI).
- `npm test` checks the Stripe signature verification and request encoding.
- To test without touching Gelato, put `GELATO_API_URL=http://127.0.0.1:<port>/v4/orders` in `.dev.vars`
  and run a small stand-in server there; never set it on the live Worker.
- On Windows, stop `wrangler dev` with Ctrl+C in its own terminal. Killing it any other way can leave
  `workerd.exe` running on port 8787, which makes the next run hang.

## Going live

1. Swap in Stripe live keys and the live webhook secret.
2. Order one hoodie yourself with `GELATO_ORDER_TYPE = "draft"` and check the draft in Gelato's
   dashboard: the files, the placement and the address.
3. Set `GELATO_ORDER_TYPE = "order"` and deploy.

## Things to confirm with Gelato

These come from Gelato's public examples. Check them against your account's API docs:
- The file type names for the front and back print areas.
- The webhook payload fields: the Worker reads `orderReferenceId`/`orderId`, `fulfillmentStatus`,
  and `trackingUrl`/`trackingCode`, either at the top level or under `items[0].fulfillments[0]`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/editions` | `{ sold: [...], held: [...], available }` |
| POST | `/api/checkout` | body `{ edition, size }`, returns `{ url }` for Stripe Checkout |
| POST | `/api/release` | body `{ hold }`: frees a number when the customer cancels |
| GET | `/api/order?session_id=` | order status for the thank-you screen |
| POST | `/api/stripe/webhook` | Stripe events (signature checked) |
| POST | `/api/gelato/webhook?token=` | Gelato status and tracking (token checked) |
| GET | `/files/...?exp=&sig=` | signed print-file links for Gelato |
