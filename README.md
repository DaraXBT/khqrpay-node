# KHQRPay for Node.js: official KHQR payments SDK for Cambodia

Accept KHQR payments from ABA, ACLEDA, Wing and every Bakong app in your Node.js or Next.js app. The money goes straight to your own ABA account. KHQRPay creates the QR, gives you a hosted checkout in Khmer and English, and tells your server the moment it’s paid with a signed webhook.

- Website: [khqrpay.dev](https://khqrpay.dev)
- API docs: [khqrpay.dev/docs](https://khqrpay.dev/docs)
- Guide: [KHQR payments with Node.js and Next.js](https://khqrpay.dev/guides/khqr-api-nodejs)

No dependencies. Node 18 or later, ESM and CommonJS, with TypeScript types. With `require`, take the class by name: `const { KHQRPay, webhooks } = require("khqrpay");`.

## Install

```bash
npm install khqrpay
```

## Create a payment

Create it on your server, never in the browser: the secret key must stay private.

```js
import KHQRPay from "khqrpay";

const khqrpay = new KHQRPay(process.env.KHQRPAY_SECRET_KEY); // kp_test_… while you build

const payment = await khqrpay.payments.create(
  { amount: "16.88", currency: "USD", reference_id: "INV-2048" },
  { idempotencyKey: `INV-2048-attempt-1` }, // one per checkout attempt
);

// Send the customer to the hosted checkout…
res.redirect(payment.checkout_url);
// …or draw payment.qr_string yourself, with a countdown to payment.expires_at.
```

Amounts are strings: dollars with up to 2 decimals (`"16.88"`), riel as whole numbers (`"20000"`). If you price in the other currency from your ABA link, KHQRPay converts it: `amount` is what the customer pays, `requested_amount` is what you asked for.

## Verify the webhook

Verify the **raw** body before you parse it as JSON.

**Express**

```js
import express from "express";
import { webhooks } from "khqrpay";

app.post("/webhooks/khqrpay", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = webhooks.constructEvent(req.body, req.get("X-KHQRPay-Signature"), process.env.KHQRPAY_WEBHOOK_SECRET);
  } catch {
    return res.sendStatus(400);
  }
  if (!event.livemode || event.test) return res.sendStatus(200); // test events: nothing to fulfil
  if (event.type === "payment.completed") {
    // Deduplicate on event.id, then fulfil event.data.payment.reference_id.
  }
  res.sendStatus(200);
});
```

**Next.js (App Router)**

```ts
// app/webhooks/khqrpay/route.ts
import { webhooks } from "khqrpay";

export async function POST(request: Request) {
  const raw = await request.text();
  if (!webhooks.verify(raw, request.headers.get("x-khqrpay-signature"), process.env.KHQRPAY_WEBHOOK_SECRET!)) {
    return new Response("bad signature", { status: 400 });
  }
  const event = JSON.parse(raw);
  // …fulfil on payment.completed, deduplicate on event.id
  return new Response("ok");
}
```

A `payment.completed` with `data.payment.late: true` can arrive after `payment.expired`: the customer paid at the last moment, so fulfil it. The full checklist is in [Verify KHQR payment webhooks](https://khqrpay.dev/guides/verify-khqr-webhooks).

## Errors and retries

Every failure throws `KHQRPayError`. Branch on `code`, never on `message`:

```js
import { KHQRPayError } from "khqrpay";

try {
  await khqrpay.payments.create({ amount: "5.00" }, { idempotencyKey });
} catch (error) {
  if (error instanceof KHQRPayError && ["rate_limited", "temporarily_unavailable", "payment_provider_error", "internal_error"].includes(error.code)) {
    // Wait error.retryAfter seconds, then retry with the SAME idempotency key.
  }
}
```

The SDK never retries by itself, so a retry can never create a second QR by accident.

## Test mode

With a `kp_test_` key, payments never reach the bank. Move one through its states:

```js
await khqrpay.payments.simulate(payment.id, "paid"); // or "scanned", "expired", "failed"
```

## Everything else

```js
await khqrpay.payments.retrieve("pay_…");
await khqrpay.payments.list({ status: "paid", limit: 20 }); // pass next_cursor as cursor for the next page
await khqrpay.usage.retrieve(); // plan, limit, used, remaining
```

## License

MIT
