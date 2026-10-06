import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Crown, Heart, Moon, Search, ShoppingBag, ShieldCheck, Sun, User } from "lucide-react";
import { CartCountBadge } from "./CartToast";
import { useDismissOnOutside } from "./shared";
import { cn } from "../../utils/cn";

export type HeaderLink = { id: string; label: string; active: boolean; onClick: () => void; vip?: boolean };
export type HeaderMenuItem = { id: string; label: string; icon: ReactNode; onClick: () => void; danger?: boolean };

/**
 * Floating LIQUID navigation object.
 * desktop ≥1024: capsule with full nav · 768–1023: compact capsule · <768: brand + search + cart
 * (search and cart are never duplicated in the bottom navigation).
 */
export default function FloatingHeader({ links, menuItems, cartCount, wishlistCount, role, accountName, accountNote, onHome, onOpenSearch, onOpenCart, onWishlist, onAuth, onDemo, dark, onToggleDark }: {
  links: HeaderLink[];
  menuItems: HeaderMenuItem[];
  cartCount: number;
  wishlistCount: number;
  role: "guest" | "customer" | "vip";
  accountName?: string;
  accountNote?: string;
  onHome: () => void;
  onOpenSearch: () => void;
  onOpenCart: () => void;
  onWishlist: () => void;
  onAuth: () => void;
  /** development / preview only — absent in a production build */
  onDemo?: () => void;
  dark: boolean;
  onToggleDark: () => void;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const frame = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setScrolled(window.scrollY > 24);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const menuRef = useDismissOnOutside<HTMLDivElement>(menuOpen, () => setMenuOpen(false));

  return (
    <header className="kv-sf-header" data-scrolled={scrolled ? "true" : "false"}>
      <div className="kv-sf-header-bar kv-liquid">
        {/* brand */}
        <button onClick={onHome} className="kv-sf-press flex shrink-0 items-center gap-2.5 rounded-full px-2 py-1.5 text-start" aria-label="کلبه وینتج — خانه">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--kvaf-charcoal)] text-[14px] font-bold text-[var(--kvaf-bone)] dark:bg-[var(--kvaf-bone)] dark:text-[var(--kvaf-charcoal)]">
            <span className="kvaf-latin tracking-normal">K</span>
          </span>
          <span className="leading-none">
            <span className="kvaf-wordmark block text-[12.5px] font-normal text-[var(--kvaf-ink)]">Kolbe</span>
            <span className="mt-1 block text-[9px] font-semibold tracking-[0.34em] text-[var(--kvaf-muted)]">VINTAGE</span>
          </span>
        </button>

        {/* primary nav — desktop only */}
        <nav className="ms-3 hidden items-center gap-0.5 lg:flex" aria-label="ناوبری اصلی">
          {links.map((link) => (
            <button
              key={link.id} onClick={link.onClick}
              aria-current={link.active ? "page" : undefined}
              data-active={link.active ? "true" : "false"}
              className="kv-sf-navlink flex items-center gap-1.5"
            >
              {link.vip && <Crown size={14} className="text-[var(--kvaf-brass-deep)]" />}
              {link.label}
            </button>
          ))}
        </nav>

        <div className="ms-auto flex items-center gap-0.5">
          {/* development-only shortcut; never part of production navigation */}
          {onDemo && (
            <button onClick={onDemo} data-from="xl" className="kv-sf-iconbtn text-[var(--kvaf-muted)] hover:text-[var(--kvaf-ink)]" aria-label="پیش‌نمایش آزمایشی پنل‌ها" title="پیش‌نمایش آزمایشی پنل‌ها">
              <ShieldCheck size={17} /><span className="text-[12px] font-semibold">تست پنل‌ها</span>
            </button>
          )}

          <button
            onClick={onToggleDark} aria-label={dark ? "حالت روشن" : "حالت تیره"}
            data-from="md"
            className="kv-sf-iconbtn"
          >
            {dark ? <Sun size={17} /> : <Moon size={17} />}
          </button>

          <button onClick={onWishlist} data-from="lg" className="kv-sf-iconbtn relative" aria-label={`علاقه‌مندی‌ها${wishlistCount ? ` — ${wishlistCount.toLocaleString("fa-IR")} مورد` : ""}`}>
            <Heart size={17} />
            {wishlistCount > 0 && <span className="absolute inset-block-start-2 inset-inline-start-[18px] h-1.5 w-1.5 rounded-full bg-[var(--kvaf-brass-deep)]" aria-hidden="true" />}
          </button>

          <button onClick={onOpenSearch} className="kv-sf-iconbtn" aria-label="جست‌وجوی محصول">
            <Search size={18} /><span className="hidden text-[12.5px] font-semibold xl:inline">جست‌وجو</span>
          </button>

          <button onClick={onOpenCart} className="kv-sf-iconbtn relative" aria-label={`سبد خرید — ${cartCount.toLocaleString("fa-IR")} قلم`}>
            <ShoppingBag size={18} />
            <CartCountBadge count={cartCount} />
          </button>

          {role === "guest" ? (
            <button
              onClick={onAuth}
              className="kv-sf-press ms-1 hidden h-10 items-center gap-2 rounded-full bg-[var(--kvaf-action)] px-4 text-[12.5px] font-bold text-[var(--kvaf-on-action)] sm:flex"
            >
              <User size={15} />ورود
            </button>
          ) : (
            <div className="relative ms-1 hidden sm:block" ref={menuRef}>
              <button
                onClick={() => setMenuOpen((open) => !open)}
                aria-expanded={menuOpen} aria-haspopup="menu"
                className={cn("kv-sf-press flex h-10 items-center gap-2 rounded-full px-1.5 pe-3", menuOpen && "bg-[rgba(28,28,25,0.06)]")}
              >
                <span className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-bold",
                  role === "vip" ? "bg-[var(--kvaf-charcoal)] text-[var(--kvaf-bone)] dark:bg-[var(--kvaf-bone)] dark:text-[var(--kvaf-charcoal)]" : "bg-[var(--kvaf-sand)] text-[var(--kvaf-ink)]",
                )} aria-hidden="true">{accountName?.[0] ?? "ک"}</span>
                <span className="hidden max-w-[110px] truncate text-[12.5px] font-bold text-[var(--kvaf-ink)] md:block">{accountName}</span>
                <ChevronDown size={14} className={cn("text-[var(--kvaf-muted)] transition-transform duration-200", menuOpen && "rotate-180")} />
              </button>
              {menuOpen && (
                <div role="menu" className="kv-sf-menu kv-frost">
                  <div className="px-3 pb-2 pt-2">
                    <p className="truncate text-[13px] font-extrabold text-[var(--kvaf-ink)]">{accountName}</p>
                    {accountNote && <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--kvaf-muted)]">{accountNote}</p>}
                  </div>
                  <div className="my-1 h-px bg-[var(--kvaf-line)]" />
                  {menuItems.map((item) => (
                    <button
                      key={item.id} role="menuitem" onClick={item.onClick}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-start text-[13px] font-semibold transition-colors",
                        item.danger ? "text-[var(--kvaf-danger)] hover:bg-[rgba(150,70,58,0.08)]" : "text-[var(--kvaf-ink)] hover:bg-[rgba(28,28,25,0.06)]",
                      )}
                    >
                      {item.icon}{item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
