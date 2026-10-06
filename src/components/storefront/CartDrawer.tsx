import { ArrowLeft, ShoppingBag, Trash2, X } from "lucide-react";
import { fmtMoney, fmtNum, type Product } from "../../data/catalog";
import type { CartLine } from "../../portals/retail";
import { lineThumbnail, useFocusTrap, useScrollLock } from "./shared";

/**
 * Cart panel in FROST material: left drawer on desktop, near-full-height sheet on
 * mobile (above the safe area, clear of the bottom navigation).
 * Pricing and cart mutations stay with the storefront state that owns them.
 */
export default function CartDrawer({ open, onClose, cart, products, subtotal, onRemove, onCheckout, onContinue }: {
  open: boolean;
  onClose: () => void;
  cart: CartLine[];
  products: Product[];
  subtotal: number;
  onRemove: (index: number) => void;
  onCheckout: () => void;
  onContinue: () => void;
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  useScrollLock(open);
  if (!open) return null;

  const count = cart.reduce((sum, line) => sum + line.qty, 0);

  return (
    <>
      <div className="kv-sf-scrim" onClick={onClose} aria-hidden="true" />
      <aside ref={trapRef} role="dialog" aria-modal="true" aria-label="سبد خرید" className="kv-sf-cart kv-frost">
        <header className="flex items-center justify-between gap-3 border-b border-[var(--kvaf-line)] px-5 py-4">
          <div>
            <h2 className="text-[16px] font-extrabold text-[var(--kvaf-ink)]">سبد خرید</h2>
            <p className="kvaf-num mt-0.5 text-[12px] text-[var(--kvaf-muted)]">{fmtNum(count)} قلم</p>
          </div>
          <button onClick={onClose} aria-label="بستن سبد" className="kv-sf-press flex h-10 w-10 items-center justify-center rounded-full text-[var(--kvaf-muted)] hover:bg-[rgba(28,28,25,0.06)]">
            <X size={18} />
          </button>
        </header>

        {cart.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--kvaf-sand)]">
              <ShoppingBag size={22} className="text-[var(--kvaf-muted)]" />
            </span>
            <p className="mt-4 text-[15px] font-bold text-[var(--kvaf-ink)]">سبد خرید خالی است</p>
            <p className="mt-1.5 max-w-[30ch] text-[13px] leading-6 text-[var(--kvaf-muted)]">
              از تازه‌رسیده‌ها شروع کنید؛ هر چه می‌پسندید با افزودن سریع به سبد می‌آید.
            </p>
            <button onClick={onContinue} className="kv-sf-action mt-6">مشاهده محصولات</button>
          </div>
        ) : (
          <>
            <ul className="kv-scroll flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {cart.map((line, index) => {
                const product = products.find((item) => item.id === line.id);
                if (!product) return null;
                /* the thumbnail follows the colour that was actually added */
                const thumb = lineThumbnail(product, line.color);
                return (
                  <li key={`${line.id}-${line.size}-${line.color}`} className="flex gap-3 rounded-[14px] bg-[var(--kvaf-sand)]/45 p-2.5">
                    {thumb
                      ? <img src={thumb} alt="" className="h-24 w-19 shrink-0 rounded-[10px] object-cover" />
                      : <span aria-hidden="true" className="h-24 w-19 shrink-0 rounded-[10px] bg-[var(--kvaf-sand)]" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-bold text-[var(--kvaf-ink)]">{product.name}</p>
                      <p className="mt-1 text-[11.5px] text-[var(--kvaf-muted)]">
                        {line.color || "بدون رنگ"}{line.size ? ` · سایز ${line.size}` : ""} · {fmtNum(line.qty)} عدد
                      </p>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <p className="kvaf-num text-[13.5px] font-extrabold text-[var(--kvaf-ink)]">
                          {fmtMoney(product.retailPrice * line.qty)}
                        </p>
                        <button
                          onClick={() => onRemove(index)}
                          aria-label={`حذف ${product.name} از سبد`}
                          className="kv-sf-press flex h-9 w-9 items-center justify-center rounded-full text-[var(--kvaf-muted)] hover:bg-[rgba(150,70,58,0.10)] hover:text-[var(--kvaf-danger)]"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <footer className="border-t border-[var(--kvaf-line)] px-5 pt-4 pb-5">
              <div className="flex items-baseline justify-between">
                <span className="text-[13px] text-[var(--kvaf-muted)]">جمع سبد</span>
                <span className="kvaf-num text-[17px] font-extrabold text-[var(--kvaf-ink)]">{fmtMoney(subtotal)}</span>
              </div>
              <p className="mt-1 text-[11.5px] text-[var(--kvaf-muted)]">هزینه ارسال و تخفیف‌ها در مرحله بعد محاسبه می‌شود.</p>
              <button onClick={onCheckout} className="kv-sf-action mt-4 w-full">
                تکمیل خرید<ArrowLeft size={16} />
              </button>
              <button onClick={onContinue} className="mt-3 w-full text-center text-[13px] font-semibold text-[var(--kvaf-muted)] hover:text-[var(--kvaf-ink)]">
                ادامه خرید
              </button>
            </footer>
          </>
        )}
      </aside>
    </>
  );
}
