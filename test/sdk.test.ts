import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import KHQRPay, { KHQRPayError, webhooks } from "../src/index";

const vectors = JSON.parse(readFileSync(new URL("./test-vectors.json", import.meta.url), "utf8"));

describe("webhook signatures: the shared vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const secret = c.secret ?? vectors.secret;
      expect(webhooks.verify(c.body, c.header, secret, { now: c.now })).toBe(c.valid);
      expect(KHQRPay.webhooks.verify(Buffer.from(c.body, "utf8"), c.header, secret, { now: c.now })).toBe(c.valid);
      if (c.valid) expect(webhooks.constructEvent(c.body, c.header, secret, { now: c.now })).toEqual(JSON.parse(c.body));
      else expect(() => webhooks.constructEvent(c.body, c.header, secret, { now: c.now })).toThrowError(expect.objectContaining({ code: "invalid_signature", status: 400 }));
    });
  }
});

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: string, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const h = (c: Call) => c.init.headers as Record<string, string>;

describe("the API client", () => {
  it("creates a payment exactly as the API expects", async () => {
    const { f, calls } = fakeFetch(201, JSON.stringify(vectors.paymentResponse));
    const client = new KHQRPay("kp_test_abc", { fetch: f });
    const payment = await client.payments.create(vectors.createRequest.body);
    expect(payment).toEqual(vectors.paymentResponse);
    expect(calls[0].url).toBe("https://khqrpay.dev/v1/payments");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual(vectors.createRequest.body);
    expect(h(calls[0])).toMatchObject({ Authorization: "Bearer kp_test_abc", "Content-Type": "application/json", "User-Agent": "khqrpay-node/0.1.0" });
    expect(h(calls[0])["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes a given idempotency key through, and sends a number amount as a string", async () => {
    const { f, calls } = fakeFetch(201, JSON.stringify(vectors.paymentResponse));
    await new KHQRPay("kp_test_abc", { fetch: f }).payments.create({ amount: 16.88 }, { idempotencyKey: "order-2048-attempt-1" });
    expect(h(calls[0])["Idempotency-Key"]).toBe("order-2048-attempt-1");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ amount: "16.88" });
  });

  it("raises the API’s error code, status and message", async () => {
    const { f } = fakeFetch(vectors.errorResponse.status, JSON.stringify(vectors.errorResponse.body));
    await expect(new KHQRPay("kp_test_abc", { fetch: f }).payments.create({ amount: "" })).rejects.toMatchObject({ code: "invalid_request", status: 400, message: "amount is required" });
  });

  it("reads Retry-After on a 429", async () => {
    const { f } = fakeFetch(429, JSON.stringify({ error: "rate_limited", message: "Too many requests" }), { "retry-after": "30" });
    const error = await new KHQRPay("kp_test_abc", { fetch: f }).payments.retrieve("pay_1").catch((e) => e);
    expect(error).toBeInstanceOf(KHQRPayError);
    expect(error).toMatchObject({ code: "rate_limited", status: 429, retryAfter: 30 });
  });

  it("reports a body that isn’t JSON as invalid_response", async () => {
    const { f } = fakeFetch(502, "<html>bad gateway</html>");
    await expect(new KHQRPay("kp_test_abc", { fetch: f }).usage.retrieve()).rejects.toMatchObject({ code: "invalid_response", status: 502 });
  });

  it("reports a transport failure as network_error", async () => {
    const f = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(new KHQRPay("kp_test_abc", { fetch: f }).usage.retrieve()).rejects.toMatchObject({ code: "network_error", status: 0 });
  });

  it("builds list queries without unset parameters, and encodes ids", async () => {
    const { f, calls } = fakeFetch(200, JSON.stringify({ object: "list", data: [], has_more: false, next_cursor: null }));
    const client = new KHQRPay("kp_live_abc", { fetch: f, baseUrl: "https://example.test/" });
    await client.payments.list({ status: "paid", limit: 20 });
    await client.payments.list();
    await client.payments.retrieve("pay/1 x");
    await client.payments.simulate("pay_1", "paid");
    expect(calls.map((c) => c.url)).toEqual([
      "https://example.test/v1/payments?status=paid&limit=20",
      "https://example.test/v1/payments",
      "https://example.test/v1/payments/pay%2F1%20x",
      "https://example.test/v1/test/payments/pay_1/simulate",
    ]);
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ status: "paid" });
  });

  it("never follows a redirect, so the key can’t leak to another host", async () => {
    const { f, calls } = fakeFetch(302, "", { location: "https://evil.test/" });
    await expect(new KHQRPay("kp_test_abc", { fetch: f }).usage.retrieve()).rejects.toMatchObject({ code: "invalid_response", status: 302 });
    expect(calls[0].init.redirect).toBe("manual");
  });

  it("refuses a signed body that isn’t a JSON object", () => {
    const secret = "whsec_x";
    const t = 1793750400;
    const body = "[1,2]";
    const { createHmac } = require("node:crypto");
    const header = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
    expect(webhooks.verify(body, header, secret, { now: t })).toBe(true);
    expect(() => webhooks.constructEvent(body, header, secret, { now: t })).toThrowError(expect.objectContaining({ code: "invalid_payload" }));
  });

  it("refuses anything that isn’t a KHQRPay secret key", () => {
    for (const bad of ["", "sk_live_x", "kp_live_", "whsec_x"]) expect(() => new KHQRPay(bad)).toThrowError(expect.objectContaining({ code: "invalid_api_key" }));
  });
});
