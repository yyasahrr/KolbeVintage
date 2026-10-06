import { ArrowLeft, Crown, Moon, Store, Sun } from "lucide-react";
import { fmtNum } from "../../data/catalog";

const persianYear = () => {
  try {
    return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric" }).format(new Date());
  } catch {
    return new Date().toLocaleDateString("fa-IR").split("/")[0];
  }
};

/**
 * Editorial ending rather than a boxed link grid.
 *
 * Honesty rules applied here:
 *  - every control on this footer performs a real action in the app; there are no
 *    decorative buttons that look like links;
 *  - there is no street address, phone number, social handle or return-policy
 *    claim, because no authoritative source for them exists in this repository
 *    (see "Footer contact contract" in docs/storefront-archive-fluid.md). They
 *    appear again the moment a real source does;
 *  - the newsletter form is gone. It used to show «ثبت شد» while persisting
 *    nothing; without a real lead endpoint the copy stays non-interactive;
 *  - `onDemo` is only passed in development, so the panel-preview shortcut never
 *    ships as production navigation.
 */
export default function StorefrontFooter({ onShop, onJournal, onStudio, onVip, onDemo, dark, onToggleDark, productCount, shippingNote }: {
  onShop: () => void;
  onJournal: () => void;
  onStudio: () => void;
  onVip: () => void;
  /** development / preview only — absent in a production build */
  onDemo?: () => void;
  dark: boolean;
  onToggleDark: () => void;
  productCount: number;
  /**
   * Delivery copy derived from the *active* shipping configuration, or undefined
   * when that configuration has nothing to say. There is deliberately no default
   * text: a blanket «ارسال به سراسر کشور» is a promise the storefront cannot back
   * from data, so the footer simply omits the line instead of inventing one.
   */
  shippingNote?: string;
}) {
  return (
    <footer className="mt-20 border-t border-[var(--kvaf-line)] bg-[var(--kvaf-surface)]">
      <div className="kv-sf-shell py-14 md:py-20">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr] lg:gap-20">
          <div>
            <p className="kvaf-wordmark text-[22px] leading-none text-[var(--kvaf-ink)] md:text-[30px]">Kolbe</p>
            <p className="kvaf-editorial mt-2 text-[26px] leading-none text-[var(--kvaf-muted)] md:text-[34px]">Vintage</p>
            <p className="kvaf-body mt-6 max-w-[42ch] text-[14px] text-[var(--kvaf-ink-2)]">
              کلبه، پلی میان اصالت و تجارت مدرن. پوشاک کلاسیک و مدرن از تأمین‌کنندگان منتخب.
            </p>
            <div className="mt-6">
              <button
                onClick={onToggleDark} aria-label={dark ? "حالت روشن" : "حالت تیره"}
                aria-pressed={dark}
                className="kv-sf-press flex h-11 w-11 items-center justify-center rounded-full border border-[var(--kvaf-line)] text-[var(--kvaf-ink-2)] hover:border-[var(--kvaf-line-strong)] hover:text-[var(--kvaf-ink)]"
              >
                {dark ? <Sun size={17} /> : <Moon size={17} />}
              </button>
            </div>
          </div>

          <div className="grid gap-10 sm:grid-cols-2">
            <nav aria-label="خرید">
              <p className="kvaf-rule mb-4"><span>Shop</span></p>
              <ul className="space-y-3 text-[13px] text-[var(--kvaf-muted)]">
                <li><button onClick={onShop} className="hover:text-[var(--kvaf-ink)]">همه محصولات ({fmtNum(productCount)})</button></li>
                <li><button onClick={onStudio} className="hover:text-[var(--kvaf-ink)]">پرو مجازی و ساخت استایل</button></li>
                <li><button onClick={onJournal} className="hover:text-[var(--kvaf-ink)]">مجله کلبه</button></li>
              </ul>
            </nav>
            <nav aria-label="همکاری">
              <p className="kvaf-rule mb-4"><span>Trade</span></p>
              <ul className="space-y-3 text-[13px] text-[var(--kvaf-muted)]">
                <li>
                  <button onClick={onVip} className="inline-flex items-center gap-1.5 hover:text-[var(--kvaf-ink)]">
                    <Crown size={13} /> بازارچه عمده
                  </button>
                </li>
                <li>
                  <a href="#/supplier" target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 hover:text-[var(--kvaf-ink)]">
                    <Store size={13} /> مرکز تأمین‌کنندگان
                  </a>
                </li>
                {onDemo && (
                  <li>
                    <button onClick={onDemo} className="inline-flex items-center gap-1.5 text-[var(--kvaf-faint)] hover:text-[var(--kvaf-ink)]">
                      <ArrowLeft size={13} /> پیش‌نمایش پنل‌ها (فقط توسعه)
                    </button>
                  </li>
                )}
              </ul>
            </nav>
          </div>
        </div>
      </div>

      <div className="border-t border-[var(--kvaf-line)]">
        <div className="kv-sf-shell flex flex-wrap items-center justify-between gap-3 py-5 text-[12px] text-[var(--kvaf-muted)]">
          <p>© {persianYear()} کلبه وینتج · تمامی حقوق محفوظ است</p>
          {shippingNote ? <p>{shippingNote}</p> : null}
        </div>
      </div>
    </footer>
  );
}
