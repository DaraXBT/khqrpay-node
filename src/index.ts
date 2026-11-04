// KHQRPay for Node.js: the official SDK for the KHQRPay API (https://khqrpay.dev/docs).
import { webcrypto, createHmac, timingSafeEqual } from "node:crypto";

export const VERSION = "0.1.1";
const DEFAULT_BASE_URL = "https://khqrpay.dev";

export type Currency = "USD" | "KHR";
export type PaymentStatus = "pending" | "scanned" | "paid" | "expired" | "failed";

export interface Payment {
  id: string;
  object: "payment";
  livemode: boolean;
  status: PaymentStatus;
  /** What the payer pays, in the ABA link's currency. USD has 2 decimals, KHR is whole riel. */
  amount: string;
  currency: Currency;
  /** What your request asked for, before any conversion. */
  requested_amount: string | null;
  requested_currency: Currency | null;
  settlement_amount: string;
  settlement_currency: Currency;
  /** Riel per US dollar used, or null when nothing was converted. */
  conversion_rate: number | null;
  reference_id: string | null;
  metadata: Record<string, unknown> | null;
  qr_string: string;
  checkout_url: string;
  approved_at: string | null;
  scanned_at: string | null;
  created_at: string;
  expires_at: string;
  /** True when KHQRPay's checks fell behind: treat an unpaid payment as unknown, not unpaid. */
  monitoring_gap?: boolean;
}

export interface PaymentList {
  object: "list";
  data: Omit<Payment, "metadata">[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface Usage {
  plan: string;
  limit: number;
  used: number;
  remaining: number;
  period_start: string;
  period_end: string;
}

export interface CreatePaymentParams {
  /** Send a string ("16.88", "20000"). A number is turned into a string as-is, never rounded. */
  amount: string | number;
  /** The currency you price in. Defaults to USD. */
  currency?: Currency;
  /** Your order id, up to 255 characters. */
  reference_id?: string;
  /** A JSON object of up to 50 keys and 4 KB, returned as sent. */
  metadata?: Record<string, unknown>;
}

export interface WebhookEvent {
  id: string;
  type: "payment.completed" | "payment.scanned" | "payment.expired" | "payment.failed" | (string & {});
  livemode: boolean;
  /** When the event was created (ISO 8601). */
  created: string;
  test?: boolean;
  data: { payment: Partial<Payment> & { id: string; status: PaymentStatus; late?: boolean } };
}

/** Every failure: branch on `code` (the API's error code), never on `message`. */
export class KHQRPayError extends Error {
  readonly code: string;
  readonly status: number;
  /** Seconds to wait before retrying, from Retry-After, or null. */
  readonly retryAfter: number | null;

  constructor(code: string, message: string, status = 0, retryAfter: number | null = null) {
    super(message);
    this.name = "KHQRPayError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface VerifyOptions {
  /** How far the signature's timestamp may be from now, in seconds. Default 300. */
  toleranceSec?: number;
  /** "Now" in Unix seconds, for tests. */
  now?: number;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Webhook signature checks. They need no API key. */
export const webhooks = {
  /**
   * True when `signatureHeader` (X-KHQRPay-Signature) is a valid signature of `rawBody` by `secret`. Pass the raw
   * body exactly as received, before any JSON parsing. Never throws.
   */
  verify(rawBody: string | Buffer | Uint8Array, signatureHeader: string | null | undefined, secret: string, options: VerifyOptions = {}): boolean {
    try {
      if (!signatureHeader || !secret) return false;
      const parts = new Map<string, string>();
      for (const part of signatureHeader.split(",")) {
        const at = part.indexOf("=");
        if (at > 0) parts.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
      }
      const t = parts.get("t") ?? "";
      const v1 = parts.get("v1") ?? "";
      if (!/^\d+$/.test(t) || !HEX64.test(v1)) return false;
      const now = options.now ?? Math.floor(Date.now() / 1000);
      if (Math.abs(now - Number(t)) > (options.toleranceSec ?? 300)) return false;
      const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
      const expected = createHmac("sha256", Buffer.from(secret, "utf8")).update(`${t}.`).update(body).digest();
      return timingSafeEqual(expected, Buffer.from(v1, "hex"));
    } catch {
      return false;
    }
  },

  /** Verifies, then returns the parsed event. Throws KHQRPayError("invalid_signature", 400) when the check fails. */
  constructEvent(rawBody: string | Buffer | Uint8Array, signatureHeader: string | null | undefined, secret: string, options: VerifyOptions = {}): WebhookEvent {
    if (!webhooks.verify(rawBody, signatureHeader, secret, options)) {
      throw new KHQRPayError("invalid_signature", "The webhook signature is missing, malformed, too old or doesn’t match.", 400);
    }
    const text = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      event = null;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new KHQRPayError("invalid_payload", "The webhook body is signed but isn’t a JSON object.", 400);
    }
    return event as WebhookEvent;
  },
};

export interface ClientOptions {
  baseUrl?: string;
  /** Request timeout in milliseconds. Default 30,000. */
  timeoutMs?: number;
  /** A fetch implementation, for tests or custom agents. Default: the global fetch. */
  fetch?: typeof fetch;
}

export class KHQRPay {
  static readonly webhooks = webhooks;
  readonly webhooks = webhooks;
  readonly payments: {
    create(params: CreatePaymentParams, options?: { idempotencyKey?: string }): Promise<Payment>;
    retrieve(id: string): Promise<Payment>;
    list(params?: { status?: PaymentStatus; limit?: number; cursor?: string }): Promise<PaymentList>;
    simulate(id: string, status: PaymentStatus): Promise<Payment>;
  };
  readonly usage: { retrieve(): Promise<Usage> };

  readonly #key: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(secretKey: string, options: ClientOptions = {}) {
    if (typeof secretKey !== "string" || !/^kp_(live|test)_\S+$/.test(secretKey)) {
      throw new KHQRPayError("invalid_api_key", "Pass a KHQRPay secret key: kp_live_… or kp_test_…, from the dashboard’s API keys page.");
    }
    this.#key = secretKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new KHQRPayError("network_error", "No fetch available: use Node 18 or later, or pass options.fetch.");
    this.#fetch = f;

    this.payments = {
      create: (params, opts = {}) => {
        const body = { ...params, amount: typeof params.amount === "number" ? String(params.amount) : params.amount };
        // A key in the body would lose to a generated header (the API lets the header win), so it becomes the header.
        const inBody = (params as { idempotency_key?: unknown }).idempotency_key;
        const key = opts.idempotencyKey ?? (typeof inBody === "string" && inBody.trim() ? inBody : webcrypto.randomUUID());
        return this.#request<Payment>("POST", "/v1/payments", body, { "Idempotency-Key": key });
      },
      retrieve: (id) => this.#request<Payment>("GET", `/v1/payments/${encodeURIComponent(id)}`),
      list: (params = {}) => {
        const q = new URLSearchParams();
        if (params.status !== undefined) q.set("status", params.status);
        if (params.limit !== undefined) q.set("limit", String(params.limit));
        if (params.cursor !== undefined) q.set("cursor", params.cursor);
        const qs = q.toString();
        return this.#request<PaymentList>("GET", `/v1/payments${qs ? `?${qs}` : ""}`);
      },
      simulate: (id, status) => this.#request<Payment>("POST", `/v1/test/payments/${encodeURIComponent(id)}/simulate`, { status }),
    };
    this.usage = { retrieve: () => this.#request<Usage>("GET", "/v1/usage") };
  }

  async #request<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#key}`,
      Accept: "application/json",
      "User-Agent": `khqrpay-node/${VERSION}`,
      ...extra,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.#timeoutMs), redirect: "manual" });
    } catch (error) {
      throw new KHQRPayError("network_error", `Couldn’t reach KHQRPay: ${error instanceof Error ? error.message : String(error)}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      // The connection dropped part-way through the answer.
      throw new KHQRPayError("network_error", `Couldn’t read KHQRPay’s answer: ${error instanceof Error ? error.message : String(error)}`, res.status);
    }
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new KHQRPayError("invalid_response", `KHQRPay answered HTTP ${res.status} with a body that isn’t JSON.`, res.status, retryAfter(res));
    }
    // Redirects aren't followed, so the key is only ever sent to the base URL.
    if (res.status >= 300 && res.status < 400) {
      throw new KHQRPayError("invalid_response", `KHQRPay answered with a redirect (HTTP ${res.status}); check baseUrl.`, res.status);
    }
    if (!res.ok) {
      const e = (json ?? {}) as { error?: unknown; message?: unknown };
      throw new KHQRPayError(typeof e.error === "string" ? e.error : "invalid_response", typeof e.message === "string" ? e.message : `HTTP ${res.status}`, res.status, retryAfter(res));
    }
    if (!json || typeof json !== "object") throw new KHQRPayError("invalid_response", "KHQRPay answered with an empty or non-object body.", res.status);
    return json as T;
  }
}

function retryAfter(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default KHQRPay;
