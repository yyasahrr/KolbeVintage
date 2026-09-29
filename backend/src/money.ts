import { badRequest } from './errors.js';

export const MAX_RIAL = 9_000_000_000_000_000_000n;
export function rial(value: string | number | bigint): bigint {
  const raw = String(value);
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw badRequest('مبلغ باید عدد صحیح و نامنفی ریال باشد.');
  const parsed = BigInt(raw);
  if (parsed > MAX_RIAL) throw badRequest('مبلغ از سقف مجاز بیشتر است.');
  return parsed;
}
/** Ledger balances can legitimately be negative (advances, over-applied prepayments). */
export function signedRial(value: string | number | bigint): bigint {
  const raw = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (!/^-?(0|[1-9]\d*)$/.test(raw)) throw badRequest('مبلغ باید عدد صحیح ریال باشد.');
  return BigInt(raw);
}

export const asRial = (value: bigint | string | number) => signedRial(value).toString();
export function addRial(values: bigint[]): bigint {
  const sum = values.reduce((total, value) => total + value, 0n);
  if (sum > MAX_RIAL) throw badRequest('مجموع مبلغ از سقف مجاز بیشتر است.');
  return sum;
}
