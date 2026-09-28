import { z } from 'zod';
import type { DbPool } from './db.js';
import { one } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { rial } from './money.js';
import type { PaymentProviderAdapter, VerifiedPayment } from './payments.js';

const tokenResponse = z.object({ code: z.number().int(), trans_id: z.uuid() });
const verificationResponse = z.object({
  code: z.number().int(), amount: z.union([z.number().int().safe(), z.string().regex(/^\d+$/)]), order_id: z.string(),
});

async function callNextPay(fetcher: typeof fetch, path: 'token' | 'verify', body: Record<string, unknown>) {
  const response = await fetcher(`https://nextpay.org/nx/gateway/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw conflict('درگاه نکست‌پی پاسخ معتبر نداد.');
  return response.json();
}

/** NextPay is used with currency IRR, so no lossy rial/toman conversion occurs. */
export class NextPayAdapter implements PaymentProviderAdapter {
  readonly providerCode = 'nextpay';
  constructor(private readonly apiKey: string, private readonly pool: DbPool, private readonly fetcher: typeof fetch = fetch) {}

  checkoutUrl(providerReference: string) { return `https://nextpay.org/nx/gateway/payment/${providerReference}`; }

  async createCheckout(input: { intentId: string; reference: string; amountRial: string; returnUrl: string }) {
    const amount = rial(input.amountRial);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw badRequest('مبلغ از سقف قابل پردازش امن این درگاه بیشتر است.');
    const callback = new URL(input.returnUrl);
    callback.searchParams.set('provider', this.providerCode);
    callback.searchParams.set('intentId', input.intentId);
    const response = tokenResponse.parse(await callNextPay(this.fetcher, 'token', {
      api_key: this.apiKey, order_id: input.reference, amount: Number(amount), currency: 'IRR',
      callback_uri: callback.toString(),
    }));
    if (response.code !== -1) throw conflict(`ایجاد درخواست در نکست‌پی ناموفق بود: ${response.code}`);
    return { url: this.checkoutUrl(response.trans_id), providerReference: response.trans_id };
  }

  async verifyNotification(rawBody: Buffer): Promise<VerifiedPayment> {
    const params = new URLSearchParams(rawBody.toString('utf8'));
    const intentId = z.uuid().parse(params.get('intentId'));
    const transId = z.uuid().parse(params.get('trans_id'));
    const intent = await one<{ reference: string; amount_rial: string; provider_reference: string | null }>(this.pool,
      `SELECT reference,amount_rial,provider_reference FROM payment_intents
       WHERE id = $1 AND provider = 'nextpay'`, [intentId]);
    if (!intent) throw notFound();
    if (intent.provider_reference !== transId) throw conflict('شناسه تراکنش نکست‌پی با درخواست پرداخت برابر نیست.');
    const amount = rial(intent.amount_rial);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw badRequest('مبلغ از سقف قابل پردازش امن این درگاه بیشتر است.');
    const result = verificationResponse.parse(await callNextPay(this.fetcher, 'verify', {
      api_key: this.apiKey, trans_id: transId, amount: Number(amount), currency: 'IRR',
    }));
    if (result.code !== 0 || result.order_id !== intent.reference || rial(String(result.amount)) !== amount)
      throw conflict('تراکنش نکست‌پی تأیید نشد یا مبلغ و شماره سفارش با درخواست برابر نیست.');
    return { provider: this.providerCode, providerEventId: `nextpay:${transId}`, providerReference: transId,
      intentId, amountRial: amount.toString(), paidAt: new Date() };
  }
}
