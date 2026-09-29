import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Crown, Mail, MapPin, Phone, ShieldCheck, Sparkles, Truck, X } from "lucide-react";
import { siteApi, type Announcement, type FooterConfig, type SiteLayout, type SiteTheme } from "../data/experience-api";
import { cn } from "../utils/cn";

/* Server-driven site chrome. Business logic stays in code; composition/theme/content come from CMS (Req 280). */

export type SiteNavigate = (target: string) => void;

const isDemo = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");

/** Loads global layout + active theme once; the storefront keeps working (static fallback) if the API is down. */
export function useSiteExperience() {
  const [layout, setLayout] = useState<SiteLayout | null>(null);
  const [theme, setTheme] = useState<SiteTheme | null>(null);
  useEffect(() => {
    if (isDemo()) return;
    let alive = true;
    siteApi.layout().then((res) => { if (alive) setLayout(res); }).catch(() => undefined);
    siteApi.theme().then((res) => { if (alive) setTheme(res.theme); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return { layout, theme };
}

const TOKEN_TO_VAR: Record<string, string[]> = {
  background: ["--kv-bg"], surface: ["--kv-surface"], surfaceSecondary: ["--kv-surface-2"], textPrimary: ["--kv-ink"],
  textSecondary: ["--kv-muted"], primary: ["--kv-action"], accent: ["--kv-accent"], border: ["--kv-line"],
  success: ["--kv-success"], warning: ["--kv-warning"], danger: ["--kv-danger"],
};

/**
 * Applies design tokens as CSS variables (Req 219-221, 226): every component reads `var(--kv-*)`,
 * so a campaign theme re-skins the whole UI without touching CSS. User dark mode keeps priority
 * (accessibility), except for themes that are dark by design.
 */
export function useThemeTokens(theme: SiteTheme | null, dark: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    const tokens = theme?.design_tokens ?? {};
    const themeIsDark = tokens.background ? luminance(tokens.background) < 0.2 : false;
    const apply = Boolean(theme) && (!dark || themeIsDark);
    for (const [token, vars] of Object.entries(TOKEN_TO_VAR)) {
      for (const cssVar of vars) {
        if (apply && tokens[token]) root.style.setProperty(cssVar, tokens[token]!);
        else root.style.removeProperty(cssVar);
      }
    }
    if (apply && tokens.radius) root.style.setProperty("--radius-card", tokens.radius); else root.style.removeProperty("--radius-card");
    root.dataset.theme = apply ? theme!.code : "";
  }, [theme, dark]);
}

function luminance(hex: string) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean.slice(0, 6);
  const n = Number.parseInt(full, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function useCountdown(endsAt?: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!endsAt) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, [endsAt]);
  if (!endsAt) return null;
  const left = Math.max(0, new Date(endsAt).getTime() - now);
  const pad = (v: number) => v.toLocaleString("fa-IR", { minimumIntegerDigits: 2 });
  return left ? `${pad(Math.floor(left / 86400000))}:${pad(Math.floor(left / 3600000) % 24)}:${pad(Math.floor(left / 60000) % 60)}:${pad(Math.floor(left / 1000) % 60)}` : null;
}

const ICONS: Record<string, React.ReactNode> = { truck: <Truck size={14} />, sparkles: <Sparkles size={14} />, crown: <Crown size={14} />, shield: <ShieldCheck size={14} /> };

/** Announcement bar with static / marquee / ticker / slider / rotating modes (Req 327-332). */
export function ServerAnnouncementBar({ announcements, onNav }: { announcements: Announcement[]; onNav: SiteNavigate }) {
  const active = useMemo(() => announcements.find((a) => typeof window === "undefined" || sessionStorage.getItem(`kv-ann-${a.id}`) !== "1") ?? null, [announcements]);
  const [hidden, setHidden] = useState(false);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const countdown = useCountdown(active?.style.showCountdown ? active.campaign?.ends_at : null);
  const rotating = active && ["rotating", "slider", "ticker"].includes(active.mode) && active.messages.length > 1;
  useEffect(() => {
    if (!rotating || paused || reduce) return;
    const ms = active!.style.speed === "fast" ? 2800 : active!.style.speed === "slow" ? 6500 : 4200;
    const t = window.setInterval(() => setIndex((i) => (i + 1) % active!.messages.length), ms);
    return () => window.clearInterval(t);
  }, [rotating, paused, reduce, active]);
  if (!active || hidden) return null;
  const style = active.style;
  const message = active.messages[index % active.messages.length]!;
  const fontFamily = style.fontFamily === "Marcellus" ? "Marcellus, Vazirmatn, serif" : style.fontFamily === "system" ? "system-ui" : undefined;
  const Msg = ({ m }: { m: Announcement["messages"][number] }) => (
    <button onClick={() => m.link && onNav(m.link)} className={cn("inline-flex items-center gap-1.5", m.link && "hover:underline")} tabIndex={m.link ? 0 : -1}>
      {m.icon && ICONS[m.icon]}{m.text}{m.ctaLabel && <span className="rounded-full border border-current/40 px-2 py-0.5 text-[11px]">{m.ctaLabel}</span>}
    </button>
  );
  return (
    <div role="region" aria-label="اعلان‌های فروشگاه" className="relative flex items-center overflow-hidden px-10 text-[12.5px] font-semibold"
      style={{ background: style.backgroundColor, color: style.textColor, minHeight: style.heightPx ?? 40, fontFamily }}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      {active.mode === "marquee" && !reduce ? (
        <div className="kv-marquee w-full overflow-hidden">
          <div className="kv-marquee-track" data-dir={style.direction ?? "rtl"} style={{ ["--kv-marquee-duration" as string]: style.speed === "fast" ? "16s" : style.speed === "slow" ? "40s" : "26s" }}>
            {[...active.messages, ...active.messages].map((m, i) => <span key={i} aria-hidden={i >= active.messages.length} className="inline-flex items-center gap-3"><Msg m={m} /><span aria-hidden>●</span></span>)}
          </div>
        </div>
      ) : (
        <div className="flex w-full items-center justify-center gap-3 text-center" aria-live={rotating ? "polite" : undefined}>
          {active.mode === "slider" && active.messages.length > 1 && <button aria-label="پیام قبلی" onClick={() => setIndex((i) => (i - 1 + active.messages.length) % active.messages.length)} className="opacity-80 hover:opacity-100"><ChevronRight size={15} /></button>}
          <span key={index} className={cn(active.mode === "ticker" && "kv-ticker-item")}><Msg m={message} /></span>
          {countdown && <span className="rounded-md bg-white/15 px-2 py-0.5 tabular-nums" role="timer" aria-label="زمان باقی‌مانده کمپین">{countdown}</span>}
          {style.ctaLabel && style.ctaTarget && <button onClick={() => onNav(style.ctaTarget!)} className="rounded-full bg-white/15 px-3 py-0.5 text-[11.5px] hover:bg-white/25">{style.ctaLabel}</button>}
          {active.mode === "slider" && active.messages.length > 1 && <button aria-label="پیام بعدی" onClick={() => setIndex((i) => (i + 1) % active.messages.length)} className="opacity-80 hover:opacity-100"><ChevronLeft size={15} /></button>}
        </div>
      )}
      {style.dismissible !== false && (
        <button onClick={() => { sessionStorage.setItem(`kv-ann-${active.id}`, "1"); setHidden(true); }} aria-label="بستن اعلان"
          className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg opacity-80 hover:opacity-100"><X size={14} /></button>
      )}
    </div>
  );
}

const SOCIAL_LABEL: Record<string, string> = { instagram: "IG", telegram: "TG", whatsapp: "WA", youtube: "YT", linkedin: "in", x: "X" };

/** CMS-configured footer rendered only from registered, validated fields (Req 279, 323). */
export function ServerFooter({ footer, onNav }: { footer: FooterConfig; onNav: SiteNavigate }) {
  return (
    <footer className="border-t border-[var(--kv-line)] bg-[var(--kv-surface)]">
      <div className="mx-auto grid w-full max-w-[1480px] gap-10 px-4 py-12 md:grid-cols-[1.3fr_repeat(3,1fr)] md:px-8">
        <div>
          <p className="kv-latin text-[16px] font-bold">{footer.brandTitle}</p>
          <p className="mt-1 text-[13px] font-semibold text-[var(--kv-muted)]">{footer.brandSubtitle}</p>
          <p className="mt-3 max-w-[40ch] text-[13px] leading-7 text-[var(--kv-muted)]">{footer.brandDescription}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {footer.social.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" aria-label={s.label} className="kv-press flex h-10 min-w-10 items-center justify-center rounded-[11px] border border-[var(--kv-line)] px-2 text-[12px] font-bold hover:border-[var(--kv-line-strong)]">{SOCIAL_LABEL[s.platform] ?? s.label}</a>)}
          </div>
        </div>
        {footer.columns.map((col) => (
          <div key={col.title}>
            <p className="mb-3.5 text-[13.5px] font-extrabold">{col.title}</p>
            <ul className="space-y-2.5 text-[13px] text-[var(--kv-muted)]">
              {col.links.map((link) => <li key={link.label}><button onClick={() => onNav(link.target)} className="hover:text-[var(--kv-accent)]">{link.label}</button></li>)}
            </ul>
          </div>
        ))}
        <div>
          <p className="mb-3.5 text-[13.5px] font-extrabold">تماس با کلبه</p>
          <ul className="space-y-2.5 text-[13px] text-[var(--kv-muted)]">
            <li className="flex items-center gap-2"><Phone size={14} /><span dir="ltr">{footer.contact.phone}</span></li>
            <li className="flex items-center gap-2"><Mail size={14} />{footer.contact.email}</li>
            <li className="flex items-start gap-2"><MapPin size={14} className="mt-1 shrink-0" />{footer.contact.address}</li>
          </ul>
        </div>
      </div>
      {footer.trustBadges.length > 0 && (
        <div className="mx-auto flex w-full max-w-[1480px] flex-wrap gap-2 px-4 pb-6 md:px-8">
          {footer.trustBadges.map((b) => <span key={b} className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kv-surface-2)] px-3 py-1.5 text-[11.5px] font-semibold"><ShieldCheck size={13} />{b}</span>)}
        </div>
      )}
      <div className="border-t border-[var(--kv-line)] py-4 text-center text-[12px] text-[var(--kv-muted)]">{footer.copyright}</div>
    </footer>
  );
}
