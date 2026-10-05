import { useState } from "react";
import { ArrowLeft, Camera, Crown, MapPin, Moon, Phone, Send, ShieldCheck, Store, Sun } from "lucide-react";
import { fmtNum } from "../../data/catalog";

const persianYear = () => {
  try {
    return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric" }).format(new Date());
  } catch {
    return new Date().toLocaleDateString("fa-IR").split("/")[0];
  }
};

/** Editorial ending rather than a boxed link grid. Every destination is a real one. */
export default function StorefrontFooter({ onShop, onJournal, onStudio, onVip, onDemo, dark, onToggleDark, productCount, shippingNote }: {
  onShop: () => void;
  onJournal: () => void;
  onStudio: () => void;
  onVip: () => void;
  onDemo: () => void;
  dark: boolean;
  onToggleDark: () => void;
  productCount: number;
  shippingNote: string;
}) {
  const [contact, setContact] = useState("");
  const [sent, setSent] = useState(false);

  return (
    <footer className="mt-20 border-t border-[var(--kvaf-line)] bg-[var(--kvaf-surface)]">
      <div className="kv-sf-shell py-14 md:py-20">
        <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr] lg:gap-20">
          <div>
            <p className="kvaf-wordmark text-[22px] leading-none text-[var(--kvaf-ink)] md:text-[30px]">Kolbe</p>
            <p className="kvaf-editorial mt-2 text-[26px] leading-none text-[var(--kvaf-muted)] md:text-[34px]">Vintage</p>
            <p className="kvaf-body mt-6 max-w-[42ch] text-[14px] text-[var(--kvaf-ink-2)]">
              کلبه، پلی میان اصالت و تجارت مدرن. پوشاک کلاسیک و مدرن از تأمین‌کنندگان منتخب،
              با ضمانت اصالت، برگشت آسان و ارسال به سراسر کشور.
            </p>
            <p className="mt-5 flex items-center gap-2 text-[12.5px] text-[var(--kvaf-muted)]">
              <MapPin size={14} /> تهران، خیابان ولیعصر، گالری کلبه
            </p>
            <p className="mt-2 flex items-center gap-2 text-[12.5px] text-[var(--kvaf-muted)]">
              <Phone size={14} /> <span className="kvaf-num" dir="ltr">۰۲۱-۹۱۰۰۸۸۰۰</span>
            </p>
            <div className="mt-6 flex gap-2">
              {[
                { icon: <Camera size={17} />, label: "اینستاگرام" },
                { icon: <Send size={17} />, label: "تلگرام" },
                { icon: <Phone size={17} />, label: "تماس" },
              ].map((item) => (
                <button
                  key={item.label} aria-label={item.label}
                  className="kv-sf-press flex h-11 w-11 items-center justify-center rounded-full border border-[var(--kvaf-line)] text-[var(--kvaf-ink-2)] hover:border-[var(--kvaf-line-strong)] hover:text-[var(--kvaf-ink)]"
                >
                  {item.icon}
                </button>
              ))}
              <button
                onClick={onToggleDark} aria-label={dark ? "حالت روشن" : "حالت تیره"}
                className="kv-sf-press flex h-11 w-11 items-center justify-center rounded-full border border-[var(--kvaf-line)] text-[var(--kvaf-ink-2)] hover:border-[var(--kvaf-line-strong)] hover:text-[var(--kvaf-ink)]"
              >
                {dark ? <Sun size={17} /> : <Moon size={17} />}
              </button>
            </div>
          </div>

          <div className="grid gap-10 sm:grid-cols-3">
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
                <li>
                  <button onClick={onDemo} className="inline-flex items-center gap-1.5 hover:text-[var(--kvaf-ink)]">
                    <ShieldCheck size={13} /> پیش‌نمایش پنل‌ها
                  </button>
                </li>
              </ul>
            </nav>
            <div>
              <p className="kvaf-rule mb-4"><span>Letter</span></p>
              <p className="text-[12.5px] leading-6 text-[var(--kvaf-muted)]">ماهی یک نامه از کالکشن‌های تازه؛ بدون تبلیغ اضافه.</p>
              <form
                className="mt-3"
                onSubmit={(event) => { event.preventDefault(); if (contact.trim()) setSent(true); }}
              >
                <label className="sr-only" htmlFor="kv-footer-contact">ایمیل یا شماره همراه</label>
                <div className="flex gap-2">
                  <input
                    id="kv-footer-contact" value={contact} onChange={(event) => { setContact(event.target.value); setSent(false); }}
                    placeholder="ایمیل یا موبایل"
                    className="h-11 min-w-0 flex-1 rounded-[12px] border border-[var(--kvaf-line)] bg-[var(--kvaf-bg)] px-3.5 text-[13px] text-[var(--kvaf-ink)] outline-none focus:border-[var(--kvaf-brass-deep)]"
                  />
                  <button type="submit" aria-label="عضویت در خبرنامه" className="kv-sf-press flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-[var(--kvaf-action)] text-[var(--kvaf-on-action)]">
                    <ArrowLeft size={17} />
                  </button>
                </div>
                {sent && <p role="status" className="mt-2 text-[11.5px] font-semibold text-[var(--kvaf-success)]">ثبت شد؛ منتظر نامه بعدی کلبه باشید.</p>}
              </form>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-[var(--kvaf-line)]">
        <div className="kv-sf-shell flex flex-wrap items-center justify-between gap-3 py-5 text-[12px] text-[var(--kvaf-muted)]">
          <p>© {persianYear()} کلبه وینتج · تمامی حقوق محفوظ است</p>
          <p>{shippingNote}</p>
        </div>
      </div>
    </footer>
  );
}
