import { z } from 'zod';

const resultSchema = z.object({ RetStatus: z.number().int(), Value: z.union([z.string(), z.number()]).optional() });

export class MeliPayamakSms {
  constructor(private readonly username: string, private readonly password: string,
    private readonly sender: string, private readonly fetcher: typeof fetch = fetch) {}

  async send(to: string, message: string): Promise<string> {
    if (!/^09\d{9}$/.test(to)) throw new Error('Invalid Iranian mobile number.');
    const form = new URLSearchParams({ username: this.username, password: this.password,
      from: this.sender, to, text: message, isFlash: 'false' });
    const response = await this.fetcher('https://rest.payamak-panel.com/api/SendSMS/SendSMS', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`MeliPayamak HTTP ${response.status}`);
    const result = resultSchema.parse(await response.json());
    if (result.RetStatus !== 1) throw new Error(`MeliPayamak status ${result.RetStatus}`);
    return String(result.Value ?? '');
  }
}
