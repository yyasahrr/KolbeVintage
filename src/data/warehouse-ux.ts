/** UI validation supplements the server's authoritative ledger protections. */
export function adjustmentPreview(row: { on_hand: number; reserved: number; damaged: number }, direction: "increase" | "decrease", quantity: string) {
  const amount = Number(quantity);
  const numeric = /^\d+$/.test(quantity) && Number.isSafeInteger(amount) && amount > 0 && amount <= 100000;
  const delta = numeric ? amount * (direction === "increase" ? 1 : -1) : 0;
  const next = Number(row.on_hand) + delta;
  const protectedStock = Number(row.reserved) + Number(row.damaged);
  const valid = numeric && next >= protectedStock;
  return { delta, next, valid, message: !numeric ? "مقدار باید عدد صحیح مثبت بین ۱ تا ۱۰۰۰۰۰ باشد." : next < protectedStock ? "موجودی جدید نمی‌تواند از مجموع رزرو و آسیب‌دیده کمتر باشد." : "" };
}

export function pendingForRows<T extends { variant_id: string | null; warehouse_id: string; inventory_domain: string; status: string }>(receipts: T[], rows: { variant_id: string; warehouse_id: string; inventory_domain: string }[]): T[] {
  return receipts.filter((receipt) => receipt.status === "pending" && rows.some((row) => row.variant_id === receipt.variant_id && row.warehouse_id === receipt.warehouse_id && row.inventory_domain === receipt.inventory_domain));
}
