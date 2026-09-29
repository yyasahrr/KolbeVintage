import type { PoolClient } from 'pg';

/** Provider-agnostic payout adapter (item 41). The wallet never hard-codes a
 *  gateway: a PayoutProviderAdapter can be backed by a bank transfer service,
 *  Vandar, a payment provider payout API or a manual reconciliation workflow. */
export interface PayoutProviderAdapter {
  providerCode: string;
  /** Starts a payout/withdrawal transfer. Returns the provider-side reference. */
  createPayout(input: {
    withdrawalId: string;
    reference: string;
    amountRial: string;
    destination: { iban?: string; bankName?: string; holderName?: string };
  }): Promise<{ providerReference: string }>;
  /** Fetches the provider-side status for reconciliation. */
  getPayoutStatus(providerReference: string): Promise<{ status: 'processing' | 'paid' | 'failed'; detail?: string }>;
}

/** Marks a withdrawal as paid after the provider confirmed the transfer. */
export async function recordPayoutResult(
  client: PoolClient,
  withdrawalId: string,
  result: { provider: string; providerReference: string; paidAt: Date },
) {
  await client.query(
    `UPDATE withdrawal_requests SET status = 'paid', provider = $2, provider_reference = $3, paid_at = $4,
       processed_at = COALESCE(processed_at, $4), updated_at = now() WHERE id = $1`,
    [withdrawalId, result.provider, result.providerReference, result.paidAt]);
}
