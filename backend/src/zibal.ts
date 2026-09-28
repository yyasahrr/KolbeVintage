import { z } from 'zod';
import { badRequest, conflict } from './errors.js';
import { rial } from './money.js';
import type { PaymentProviderAdapter, VerifiedPayment } from './payments.js';

const requestResponse = z.object({ result: z.number(), trackId: z.number().int().safe() });
const verifyResponse = z.object({ result: z.number(), amount: z.number().int().safe(), paidAt: z.string().optional(), refNumber: z.union([z.string(), z.number()]).optional() });

async function callZibal(fetcher: typeof fetch, path: 'request' | 'verify', body: Record<string, unknown>) {
  const response = await fetcher(`https://gateway.zibal.ir/v1/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw conflict('درگاه زیبال پاسخ معتبر نداد.');
  return response.json();
}

/** Callback fields are never trusted as payment proof; verify is always called server-to-server. */
export class ZibalAdapter implements PaymentProviderAdapter {
  readonly providerCode = 'zibal';
  constructor(private readonly merchant: string, private readonly fetcher: typeof fetch = fetch) {}

  checkoutUrl(providerReference: string) { return `https://gateway.zibal.ir/start/${providerReference}`; }

  async createCheckout(input: { intentId: string; reference: string; amountRial: string; returnUrl: string }) {
    const amount = rial(input.amountRial);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw badRequest('مبلغ از سقف قابل پردازش امن این درگاه بیشتر است.');
    const callback = new URL(input.returnUrl);
    callback.searchParams.set('provider', this.providerCode);
    callback.searchParams.set('intentId', input.intentId);
    const result = requestResponse.parse(await callZibal(this.fetcher, 'request', {
      merchant: this.merchant, amount: Number(amount), callbackUrl: callback.toString(), description: input.reference,
    }));
    if (result.result !== 100) throw conflict(`ایجاد درخواست در زیبال ناموفق بود: ${result.result}`);
    return { url: this.checkoutUrl(String(result.trackId)), providerReference: String(result.trackId) };
  }

  async verifyNotification(rawBody: Buffer): Promise<VerifiedPayment> {
    const params = new URLSearchParams(rawBody.toString('utf8'));
    const intentId = z.uuid().parse(params.get('intentId'));
    const trackId = z.string().regex(/^\d+$/).parse(params.get('trackId'));
    const numericTrackId = Number(trackId);
    if (!Number.isSafeInteger(numericTrackId)) throw badRequest('شناسه پیگیری زیبال معتبر نیست.');
    const result = verifyResponse.parse(await callZibal(this.fetcher, 'verify', { merchant: this.merchant, trackId: numericTrackId }));
    if (result.result !== 100 && result.result !== 201) throw conflict(`پرداخت زیبال تأیید نشد: ${result.result}`);
    const paidAt = result.paidAt ? new Date(result.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) throw conflict('زمان پرداخت زیبال معتبر نیست.');
    return { provider: this.providerCode, providerEventId: `zibal:${trackId}`, providerReference: trackId,
      intentId, amountRial: String(result.amount), paidAt };
  }
}
