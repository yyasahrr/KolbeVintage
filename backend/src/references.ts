import type { PoolClient } from 'pg';
import { one } from './db.js';

/** Unified, gap-free-at-the-application-level document numbering (item 27).
 *  Every money document, ticket, withdrawal, return and cooperation request
 *  gets a stable reference the admin can search for. */
export const DOCUMENT_PREFIX = {
  invoice: 'INV',
  settlement: 'SET',
  withdrawal: 'WDR',
  transaction: 'TXN',
  return: 'RTN',
  cooperation: 'COOP',
  credit_note: 'CN',
} as const;

export type DocumentType = keyof typeof DOCUMENT_PREFIX;

export async function nextDocumentReference(client: PoolClient, type: DocumentType, date = new Date()): Promise<string> {
  const row = await one<{ last_number: string }>(client,
    `INSERT INTO document_sequences(document_type, last_number) VALUES ($1, 1)
     ON CONFLICT (document_type) DO UPDATE SET last_number = document_sequences.last_number + 1, updated_at = now()
     RETURNING last_number`, [type]);
  const year = date.getFullYear();
  const sequence = String(row!.last_number).padStart(6, '0');
  return `${DOCUMENT_PREFIX[type]}-${year}-${sequence}`;
}
