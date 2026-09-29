import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft, BadgeCheck, Camera, CircleHelp, Crown, FileText, Gift, Heart, KeyRound, Loader2, LogOut, MapPin, Monitor, Package,
  Pencil, ShieldCheck, ShoppingBag, Smartphone, Sparkles, Star, Ticket, Trash2, Truck, User,
} from "lucide-react";
import {
  accountApi, mediaSrc, profileApi, rialToToman, styleApi, type CommerceProduct, type Coupon, type DashboardResponse, type OtpTicket,
  type ProfileResponse, type SavedStyle,
} from "../data/experience-api";
import { getAccessToken, getApiBaseUrl } from "../data/api";
import { fmtMoney } from "../data/catalog";
import { formatPersianDate, formatPersianDateTime } from "../data/persian-date";
import { PersianDatePicker } from "../components/persian-date-picker";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, Status } from "../components/primitives";
import { StarInput } from "../components/product-reviews";
import { useToast } from "../components/toast";
import { cn } from "../utils/cn";

/* Customer account center (Req 342-354): mobile-first dashboard + self-service profile + security.
   Every number comes from the server; the UI never computes business values. */

const fa = (n: number) => n.toLocaleString("fa-IR");
type Go = (tab: string) => void;

function useLoad<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { setError(null); try { setData(await fn()); } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری"); } }, [fn]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, load, setData };
}

function ProductStrip({ title, items, onOpen, empty }: { title: string; items: CommerceProduct[]; onOpen: (id: string) => void; empty?: string }) {
  if (!items.length && !empty) return null;
  return (
    <section>
      <h3 className="mb-3 text-[15px] font-extrabold">{title}</h3>
      {items.length ? (
        <div className="kv-no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:grid md:grid-cols-4 md:overflow-visible md:px-0">
          {items.slice(0, 8).map((p) => (
            <button key={p.id} onClick={() => onOpen(p.id)} className="group w-[42%] shrink-0 snap-start text-right md:w-auto">
              <div className="kv-img aspect-[3/4] overflow-hidden rounded-[14px] bg-[var(--kv-surface-2)]">{p.image && <img src={mediaSrc(p.image)} alt={p.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />}</div>
              <p className="mt-2 line-clamp-1 text-[12.5px] font-bold">{p.name}</p>
              <p className="text-[12px] tabular-nums text-[var(--kv-muted)]">{fmtMoney(rialToToman(p.priceRial))}{p.available < 1 && " · ناموجود"}</p>
            </button>
          ))}
        </div>
      ) : <p className="text-[12.5px] text-[var(--kv-muted)]">{empty}</p>}
    </section>
  );
}

export function CouponCard({ c }: { c: Coupon }) {
  const toast = useToast();
  const value = c.type === "percent" ? `٪${fa(Number(c.value))}` : fmtMoney(rialToToman(c.value));
  const dead = c.used || c.expired;
  return (
    <div className={cn("relative flex overflow-hidden rounded-[16px] border border-dashed", dead ? "border-[var(--kv-line)] opacity-60" : "border-[var(--kv-accent)]/60 bg-[var(--kv-accent)]/[0.04]")}>
      <div className="flex w-24 shrink-0 flex-col items-center justify-center border-l border-dashed border-[var(--kv-line)] p-3 text-center">
        <b className="text-[20px] font-extrabold text-[var(--kv-accent)]">{value}</b><span className="text-[10.5px] text-[var(--kv-muted)]">تخفیف</span>
      </div>
      <div className="min-w-0 flex-1 p-3">
        <p className="truncate text-[13px] font-bold">{c.campaign_name ?? (c.source === "crm_automation" ? "کوپن اختصاصی شما" : "کوپن تخفیف")}</p>
        <p className="mt-0.5 text-[11.5px] text-[var(--kv-muted)]">تا {formatPersianDate(c.ends_at)}{Number(c.min_order_rial) > 0 && ` · حداقل خرید ${fmtMoney(rialToToman(c.min_order_rial))}`}</p>
        <div className="mt-2 flex items-center gap-2">
          <code className="rounded-md bg-[var(--kv-surface-2)] px-2 py-1 text-[12px] font-bold" dir="ltr">{c.code}</code>
          {dead ? <span className="text-[11px] font-bold text-[var(--kv-muted)]">{c.used ? "استفاده شده" : "منقضی"}</span>
            : <button onClick={() => { void navigator.clipboard?.writeText(c.code); toast.push("کد تخفیف کپی شد."); }} className="text-[11.5px] font-bold text-[var(--kv-accent)]">کپی کد</button>}
        </div>
      </div>
    </div>
  );
}

/* ============================ Dashboard overview (Req 343-347, 354) ============================ */

export function DashboardOverview({ go, onOpenProduct, onShop, onStudio, cartCount }: { go: Go; onOpenProduct: (id: string) => void; onShop: () => void; onStudio: () => void; cartCount: number }) {
  const { data, error, load } = useLoad(accountApi.dashboard);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState label="در حال آماده‌سازی داشبورد…" />;
  const d: DashboardResponse = data;
  const banner = d.appearance?.welcomeBanner;
  const tone = banner?.tone === "terra" ? "bg-[#A34E2E] text-white" : banner?.tone === "stone" ? "bg-[var(--kv-surface-2)]" : "bg-[#1B2A4A] text-[#F5EFE3]";
  const cards: { label: string; value: string; icon: ReactNode; tab: string }[] = [
    { label: "سفارش‌های فعال", value: fa(d.summary.activeOrders), icon: <Truck size={17} />, tab: "orders" },
    { label: "تحویل‌شده", value: fa(d.summary.deliveredOrders), icon: <Package size={17} />, tab: "orders" },
    { label: "علاقه‌مندی‌ها", value: fa(d.summary.wishlist), icon: <Heart size={17} />, tab: "wishlist" },
    { label: "سبد ذخیره‌شده", value: fa(cartCount), icon: <ShoppingBag size={17} />, tab: "cart" },
    { label: "کوپن‌های من", value: fa(d.summary.coupons), icon: <Gift size={17} />, tab: "coupons" },
    { label: `سطح ${d.summary.loyalty.tier.label}`, value: `${fa(d.summary.loyalty.points)} امتیاز`, icon: <Crown size={17} />, tab: "timeline" },
  ];
  const actions: { label: string; icon: ReactNode; tab: string }[] = [
    { label: "پیگیری سفارش", icon: <Truck size={16} />, tab: "orders" }, { label: "فاکتورها", icon: <FileText size={16} />, tab: "invoices" },
    { label: "ویرایش پروفایل", icon: <Pencil size={16} />, tab: "profile" }, { label: "آدرس‌ها", icon: <MapPin size={16} />, tab: "addresses" },
    { label: "علاقه‌مندی‌ها", icon: <Heart size={16} />, tab: "wishlist" }, { label: "استایل‌ها", icon: <Sparkles size={16} />, tab: "styles" },
    { label: "ثبت تیکت", icon: <CircleHelp size={16} />, tab: "support" },
  ];
  return (
    <div className="space-y-7">
      <section className={cn("rounded-[20px] p-5 md:p-7", tone)}>
        <p className="text-[12px] font-bold opacity-80">{banner?.eyebrow ?? "حساب کلبه"}</p>
        <h2 className="mt-1 text-[22px] font-extrabold md:text-[26px]">سلام، {d.greetingName}</h2>
        <p className="mt-1.5 max-w-[60ch] text-[13px] leading-7 opacity-85">{banner?.subtitle ?? "سفارش‌ها، کوپن‌ها و استایل‌های شما در یک نگاه."}</p>
        {d.summary.loyalty.tier.next && <p className="mt-3 text-[12px] opacity-80">{fa(d.summary.loyalty.tier.next - d.summary.loyalty.points)} امتیاز تا سطح بعد</p>}
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((c) => (
          <button key={c.label} onClick={() => go(c.tab)} className="kv-press rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3.5 text-right hover:border-[var(--kv-line-strong)]">
            <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-[var(--kv-surface-2)] text-[var(--kv-accent)]">{c.icon}</span>
            <p className="mt-3 text-[17px] font-extrabold tabular-nums">{c.value}</p><p className="text-[11.5px] text-[var(--kv-muted)]">{c.label}</p>
          </button>
        ))}
      </section>

      {d.activeOrder && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><p className="text-[12px] text-[var(--kv-muted)]">سفارش فعال</p><p className="text-[16px] font-extrabold tabular-nums" dir="ltr">{d.activeOrder.reference}</p></div>
            <div className="flex items-center gap-2"><Status value={d.activeOrder.timeline.filter((s) => s.done).at(-1)?.label ?? "ثبت سفارش"} /><b className="tabular-nums">{fmtMoney(rialToToman(d.activeOrder.total_rial))}</b></div>
          </div>
          <ol className="mt-5 grid grid-cols-5 gap-1" aria-label="مراحل سفارش">
            {d.activeOrder.timeline.map((step, i) => (
              <li key={step.key} className="text-center" aria-current={step.done && !d.activeOrder!.timeline[i + 1]?.done ? "step" : undefined}>
                <div className="flex items-center"><span className={cn("h-1 flex-1", i === 0 ? "opacity-0" : step.done ? "bg-[var(--kv-success)]" : "bg-[var(--kv-surface-3)]")} />
                  <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold", step.done ? "bg-[var(--kv-success)] text-white" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>{step.done ? "✓" : fa(i + 1)}</span>
                  <span className={cn("h-1 flex-1", i === d.activeOrder!.timeline.length - 1 ? "opacity-0" : d.activeOrder!.timeline[i + 1]?.done ? "bg-[var(--kv-success)]" : "bg-[var(--kv-surface-3)]")} /></div>
                <p className="mt-1.5 text-[11px] font-bold">{step.label}</p>{step.at && <p className="text-[10px] text-[var(--kv-muted)]">{formatPersianDate(step.at)}</p>}
              </li>
            ))}
          </ol>
          <p className="mt-4 text-[12.5px] text-[var(--kv-muted)]">کد رهگیری مرسوله: {d.activeOrder.tracking_code ? <b className="text-[var(--kv-ink)]" dir="ltr">{d.activeOrder.tracking_code}</b> : "پس از ارسال ثبت می‌شود"}</p>
        </Card>
      )}

      <section>
        <h3 className="mb-3 text-[15px] font-extrabold">دسترسی سریع</h3>
        <div className="kv-no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
          {actions.map((a) => <button key={a.label} onClick={() => go(a.tab)} className="kv-press flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 text-[12.5px] font-bold hover:border-[var(--kv-accent)]">{a.icon}{a.label}</button>)}
        </div>
      </section>

      {d.appearance?.promoCard.enabled && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-[var(--kv-accent)]/30 bg-[var(--kv-accent)]/[0.05] p-5">
          <div><p className="text-[14px] font-extrabold">{d.appearance.promoCard.title}</p><p className="mt-1 text-[12.5px] text-[var(--kv-muted)]">{d.appearance.promoCard.subtitle}</p></div>
          <Btn variant="accent" size="sm" onClick={onShop}>{d.appearance.promoCard.ctaLabel}</Btn>
        </section>
      )}

      {d.coupons.filter((c) => !c.used).length > 0 && (
        <section><div className="mb-3 flex items-center justify-between"><h3 className="text-[15px] font-extrabold">کوپن‌های من</h3><button onClick={() => go("coupons")} className="text-[12.5px] font-bold text-[var(--kv-accent)]">همه</button></div>
          <div className="grid gap-3 md:grid-cols-2">{d.coupons.filter((c) => !c.used).slice(0, 2).map((c) => <CouponCard key={c.id} c={c} />)}</div></section>
      )}

      <ProductStrip title={d.appearance?.recommendationHeading ?? "پیشنهاد برای شما"} items={d.personalization.forYou} onOpen={onOpenProduct} empty="با اولین خرید یا علاقه‌مندی، پیشنهادهای شخصی شما اینجا ظاهر می‌شوند." />
      <ProductStrip title="آخرین بازدیدها" items={d.personalization.recentlyViewed} onOpen={onOpenProduct} />
      <ProductStrip title="دوباره بخرید" items={d.personalization.buyAgain} onOpen={onOpenProduct} />
      <ProductStrip title="از علاقه‌مندی‌های شما" items={d.personalization.wishlistProducts} onOpen={onOpenProduct} />
      {d.personalization.suggestedStyles.length > 0 && (
        <section><h3 className="mb-3 text-[15px] font-extrabold">استایل‌های پیشنهادی</h3>
          <div className="grid gap-3 md:grid-cols-3">{d.personalization.suggestedStyles.map((s) => <a key={s.id} href={`#/style/${s.share_code}`} onClick={() => window.setTimeout(onStudio, 0)} className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4 hover:border-[var(--kv-accent)]"><p className="text-[13.5px] font-bold">{s.name}</p><p className="mt-1 text-[12px] text-[var(--kv-muted)]">امتیاز سازگاری {fa(s.score)}</p></a>)}</div></section>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        {(d.appearance?.helpCards ?? []).map((h) => <button key={h.title} onClick={() => go(h.action === "shop" ? "orders" : h.action)} className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4 text-right hover:border-[var(--kv-line-strong)]"><p className="text-[13.5px] font-bold">{h.title}</p><p className="mt-1 text-[12px] leading-6 text-[var(--kv-muted)]">{h.desc}</p></button>)}
        {d.reviewableCount > 0 && <button onClick={() => go("reviews")} className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4 text-right"><p className="flex items-center gap-1.5 text-[13.5px] font-bold"><Star size={15} className="text-[#D6A94E]" />{fa(d.reviewableCount)} محصول منتظر نظر شماست</p><p className="mt-1 text-[12px] text-[var(--kv-muted)]">تجربه خریدتان را با دیگران به اشتراک بگذارید.</p></button>}
      </section>
    </div>
  );
}

/* ============================ Profile (Req 334-337, 341) ============================ */

async function resizeAvatar(file: File): Promise<{ blob: Blob; mime: string }> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("فقط تصاویر JPG، PNG و WebP مجاز هستند.");
  if (file.size > 8 * 1024 * 1024) throw new Error("حجم فایل انتخابی بیش از ۸ مگابایت است.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error("تصویر قابل خواندن نیست.")); im.src = url; });
    const size = 512; const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (side < 64) throw new Error("ابعاد تصویر باید دست‌کم ۶۴ پیکسل باشد.");
    const canvas = document.createElement("canvas"); canvas.width = size; canvas.height = size;
    canvas.getContext("2d")!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    const mime = "image/jpeg";
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("تبدیل تصویر ناموفق بود."))), mime, 0.88));
    return { blob, mime };
  } finally { URL.revokeObjectURL(url); }
}

export function ProfileCenter({ onUpdated }: { onUpdated?: (displayName: string) => void }) {
  const toast = useToast();
  const { data, error, load, setData } = useLoad(profileApi.get);
  const [form, setForm] = useState({ firstName: "", lastName: "", birthday: null as string | null, city: "", postalCode: "" });
  const [busy, setBusy] = useState("");
  const [contact, setContact] = useState<{ channel: "phone" | "email"; value: string; ticket: (OtpTicket & { target: string }) | null; code: string } | null>(null);
  const [pwd, setPwd] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [otpPwd, setOtpPwd] = useState<{ ticket: OtpTicket | null; code: string; newPassword: string; confirmPassword: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!data) return;
    const u = data.user;
    setForm({ firstName: u.firstName ?? u.displayName.split(" ")[0] ?? "", lastName: u.lastName ?? u.displayName.split(" ").slice(1).join(" "), birthday: u.birthday ? new Date(u.birthday).toISOString() : null, city: u.city ?? "", postalCode: u.postalCode ?? "" });
  }, [data]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState label="در حال دریافت پروفایل…" />;
  const p: ProfileResponse = data;

  const toDate = (iso: string | null) => { if (!iso) return null; const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const saveInfo = async () => {
    if (!form.firstName.trim() || !form.lastName.trim()) { toast.push("نام و نام خانوادگی الزامی است.", "error"); return; }
    if (form.postalCode && !/^\d{10}$/.test(form.postalCode)) { toast.push("کد پستی باید ۱۰ رقم باشد.", "error"); return; }
    setBusy("info");
    try {
      const res = await profileApi.update({ firstName: form.firstName.trim(), lastName: form.lastName.trim(), birthday: toDate(form.birthday), city: form.city.trim() || null, postalCode: form.postalCode || null });
      toast.push("اطلاعات شخصی ذخیره شد."); onUpdated?.(res.displayName); await load();
    } catch (e) { toast.push(e instanceof Error ? e.message : "ذخیره ناموفق بود", "error"); } finally { setBusy(""); }
  };
  const uploadAvatar = async (file: File) => {
    setBusy("avatar");
    try {
      const { blob, mime } = await resizeAvatar(file);
      const res = await profileApi.uploadAvatar(blob, mime);
      setData({ ...p, user: { ...p.user, avatarUrl: res.avatarUrl } });
      toast.push("تصویر پروفایل به‌روزرسانی شد.");
    } catch (e) { toast.push(e instanceof Error ? e.message : "بارگذاری ناموفق بود", "error"); } finally { setBusy(""); }
  };
  const requestContact = async () => {
    if (!contact) return;
    setBusy("contact");
    try { const ticket = await profileApi.requestContactChange(contact.channel, contact.value.trim()); setContact({ ...contact, ticket }); toast.push(contact.channel === "phone" ? "کد تأیید به شماره جدید پیامک شد." : "کد تأیید برای ایمیل جدید ارسال شد.", "info"); }
    catch (e) { toast.push(e instanceof Error ? e.message : "درخواست ناموفق بود", "error"); } finally { setBusy(""); }
  };
  const verifyContact = async () => {
    if (!contact?.ticket) return;
    setBusy("contact");
    try { await profileApi.verifyContactChange(contact.ticket.requestId, contact.code); toast.push(contact.channel === "phone" ? "شماره همراه تغییر کرد." : "ایمیل تغییر کرد."); setContact(null); await load(); }
    catch (e) { toast.push(e instanceof Error ? e.message : "کد صحیح نیست", "error"); } finally { setBusy(""); }
  };
  const changePassword = async () => {
    if (pwd.newPassword.length < 12) { toast.push("رمز جدید باید دست‌کم ۱۲ نویسه باشد.", "error"); return; }
    if (pwd.newPassword !== pwd.confirmPassword) { toast.push("تکرار رمز با رمز جدید یکسان نیست.", "error"); return; }
    setBusy("pwd");
    try { const res = await profileApi.changePassword(pwd); toast.push(`رمز عبور تغییر کرد${res.otherSessionsRevoked ? ` و ${fa(res.otherSessionsRevoked)} نشست دیگر خارج شد` : ""}.`); setPwd({ currentPassword: "", newPassword: "", confirmPassword: "" }); }
    catch (e) { toast.push(e instanceof Error ? e.message : "تغییر رمز ناموفق بود", "error"); } finally { setBusy(""); }
  };

  const membership = p.roleProfiles.vip as Record<string, string> | null;
  return (
    <div className="max-w-[720px] space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="relative">
            <span className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-[var(--kv-surface-2)] text-[26px] font-extrabold text-[var(--kv-accent)]">
              {p.user.avatarUrl ? <img src={mediaSrc(p.user.avatarUrl)} alt="تصویر پروفایل" className="h-full w-full object-cover" /> : (p.user.firstName ?? p.user.displayName)[0]}
            </span>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadAvatar(f); e.target.value = ""; }} />
            <button onClick={() => fileRef.current?.click()} aria-label="تغییر تصویر پروفایل" className="absolute -bottom-1 -left-1 flex h-9 w-9 items-center justify-center rounded-full border-2 border-[var(--kv-surface)] bg-[var(--kv-action)] text-[var(--kv-bg)]">{busy === "avatar" ? <Loader2 size={15} className="animate-spin" /> : <Camera size={15} />}</button>
          </div>
          <div className="min-w-0 flex-1"><p className="text-[17px] font-extrabold">{p.user.displayName}</p><p className="text-[12px] text-[var(--kv-muted)]">عضو از {formatPersianDate(p.user.createdAt)} · {p.roles.includes("supplier") ? "تأمین‌کننده" : membership ? "عضو عمده" : "مشتری"}</p>
            <p className="mt-1 text-[11px] text-[var(--kv-muted)]">JPG، PNG یا WebP — به‌صورت خودکار به ۵۱۲×۵۱۲ برش و فشرده می‌شود.</p></div>
          {p.user.avatarUrl && <Btn size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={async () => { await profileApi.removeAvatar(); setData({ ...p, user: { ...p.user, avatarUrl: null } }); }}>حذف تصویر</Btn>}
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <p className="flex items-center gap-2 text-[15px] font-extrabold"><User size={16} />اطلاعات شخصی</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="نام"><Input value={form.firstName} onChange={(firstName) => setForm({ ...form, firstName })} /></Field>
          <Field label="نام خانوادگی"><Input value={form.lastName} onChange={(lastName) => setForm({ ...form, lastName })} /></Field>
          <PersianDatePicker label="تاریخ تولد" value={form.birthday} onChange={(birthday) => setForm({ ...form, birthday })} />
          <Field label="شهر"><Input value={form.city} onChange={(city) => setForm({ ...form, city })} /></Field>
          <Field label="کد پستی" hint="۱۰ رقم"><Input value={form.postalCode} onChange={(v) => setForm({ ...form, postalCode: v.replace(/\D/g, "").slice(0, 10) })} /></Field>
        </div>
        <Btn variant="accent" size="sm" disabled={busy === "info"} icon={busy === "info" ? <Loader2 size={14} className="animate-spin" /> : undefined} onClick={saveInfo}>ذخیره اطلاعات</Btn>
        <p className="text-[11.5px] text-[var(--kv-muted)]">نشانی‌ها را از تب «نشانی‌ها» مدیریت کنید.</p>
      </Card>

      <Card className="space-y-3 p-5">
        <p className="flex items-center gap-2 text-[15px] font-extrabold"><Smartphone size={16} />شماره همراه و ایمیل</p>
        <p className="text-[12px] leading-6 text-[var(--kv-muted)]">این اطلاعات حساس‌اند و فقط پس از تأیید با کد یک‌بارمصرف تغییر می‌کنند.</p>
        {(["phone", "email"] as const).map((ch) => (
          <div key={ch} className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-[var(--kv-line)] px-4 py-3">
            <div><p className="text-[12px] text-[var(--kv-muted)]">{ch === "phone" ? "شماره همراه" : "ایمیل"}</p><p className="text-[13.5px] font-bold" dir="ltr">{(ch === "phone" ? p.user.phone : p.user.email) ?? "ثبت نشده"}</p></div>
            <Btn size="sm" variant="soft" onClick={() => setContact({ channel: ch, value: "", ticket: null, code: "" })}>تغییر</Btn>
          </div>
        ))}
      </Card>

      <Card className="space-y-3 p-5">
        <p className="flex items-center gap-2 text-[15px] font-extrabold"><KeyRound size={16} />تغییر رمز عبور</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="رمز فعلی"><Input type="password" value={pwd.currentPassword} onChange={(currentPassword) => setPwd({ ...pwd, currentPassword })} /></Field>
          <Field label="رمز جدید" hint="حداقل ۱۲ نویسه"><Input type="password" value={pwd.newPassword} onChange={(newPassword) => setPwd({ ...pwd, newPassword })} /></Field>
          <Field label="تکرار رمز جدید"><Input type="password" value={pwd.confirmPassword} onChange={(confirmPassword) => setPwd({ ...pwd, confirmPassword })} /></Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn variant="accent" size="sm" disabled={busy === "pwd" || !pwd.currentPassword} onClick={changePassword}>تغییر رمز</Btn>
          <Btn variant="ghost" size="sm" onClick={() => setOtpPwd({ ticket: null, code: "", newPassword: "", confirmPassword: "" })}>رمز فعلی را نمی‌دانم (ورود با کد پیامکی)</Btn>
        </div>
      </Card>

      <Modal open={!!contact} onClose={() => setContact(null)} max="max-w-[440px]" title="تغییر اطلاعات تماس">
        {contact && (
          <div className="space-y-4 pl-10">
            <p className="text-[16px] font-extrabold">{contact.channel === "phone" ? "تغییر شماره همراه" : "تغییر ایمیل"}</p>
            {!contact.ticket ? (<>
              <Field label={contact.channel === "phone" ? "شماره جدید" : "ایمیل جدید"}><Input value={contact.value} onChange={(value) => setContact({ ...contact, value: contact.channel === "phone" ? value.replace(/\D/g, "").slice(0, 11) : value })} /></Field>
              <Btn variant="accent" className="w-full" disabled={busy === "contact" || (contact.channel === "phone" ? !/^09\d{9}$/.test(contact.value) : !/^\S+@\S+\.\S+$/.test(contact.value))} onClick={requestContact}>ارسال کد تأیید</Btn>
            </>) : (<>
              <p className="text-[12.5px] leading-6 text-[var(--kv-muted)]">کد ۶ رقمی ارسال‌شده به <b dir="ltr">{contact.ticket.target}</b> را وارد کنید (اعتبار ۱۰ دقیقه).</p>
              {contact.ticket.devCode && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900">محیط توسعه — کد: <b dir="ltr">{contact.ticket.devCode}</b></p>}
              <Field label="کد تأیید"><Input value={contact.code} onChange={(code) => setContact({ ...contact, code: code.replace(/\D/g, "").slice(0, 6) })} /></Field>
              <Btn variant="accent" className="w-full" disabled={busy === "contact" || contact.code.length !== 6} onClick={verifyContact}>تأیید و ذخیره</Btn>
            </>)}
          </div>
        )}
      </Modal>
      <Modal open={!!otpPwd} onClose={() => setOtpPwd(null)} max="max-w-[440px]" title="تنظیم رمز با کد پیامکی">
        {otpPwd && (
          <div className="space-y-4 pl-10">
            <p className="text-[16px] font-extrabold">تنظیم رمز عبور با کد یک‌بارمصرف</p>
            {!otpPwd.ticket ? <Btn variant="accent" className="w-full" onClick={async () => { try { setOtpPwd({ ...otpPwd, ticket: await profileApi.requestPasswordOtp() }); } catch (e) { toast.push(e instanceof Error ? e.message : "خطا", "error"); } }}>ارسال کد به شماره همراه تأییدشده</Btn> : (<>
              <p className="text-[12.5px] text-[var(--kv-muted)]">کد به <b dir="ltr">{otpPwd.ticket.target}</b> ارسال شد.</p>
              {otpPwd.ticket.devCode && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900">محیط توسعه — کد: <b dir="ltr">{otpPwd.ticket.devCode}</b></p>}
              <Field label="کد تأیید"><Input value={otpPwd.code} onChange={(code) => setOtpPwd({ ...otpPwd, code: code.replace(/\D/g, "").slice(0, 6) })} /></Field>
              <Field label="رمز جدید"><Input type="password" value={otpPwd.newPassword} onChange={(newPassword) => setOtpPwd({ ...otpPwd, newPassword })} /></Field>
              <Field label="تکرار رمز جدید"><Input type="password" value={otpPwd.confirmPassword} onChange={(confirmPassword) => setOtpPwd({ ...otpPwd, confirmPassword })} /></Field>
              <Btn variant="accent" className="w-full" disabled={otpPwd.code.length !== 6 || otpPwd.newPassword.length < 12} onClick={async () => {
                try { await profileApi.setPasswordWithOtp(otpPwd.ticket!.requestId, { code: otpPwd.code, newPassword: otpPwd.newPassword, confirmPassword: otpPwd.confirmPassword }); toast.push("رمز عبور تنظیم شد."); setOtpPwd(null); }
                catch (e) { toast.push(e instanceof Error ? e.message : "خطا", "error"); }
              }}>ذخیره رمز</Btn>
            </>)}
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ============================ Security (Req 351) ============================ */

export function SecurityCenter({ onLoggedOut }: { onLoggedOut: () => void }) {
  const toast = useToast();
  const { data, error, load } = useLoad(profileApi.security);
  const [password, setPassword] = useState("");
  const [confirm2fa, setConfirm2fa] = useState<boolean | null>(null);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState label="در حال دریافت وضعیت امنیتی…" />;
  return (
    <div className="max-w-[760px] space-y-6">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div><p className="flex items-center gap-2 text-[15px] font-extrabold"><ShieldCheck size={16} />ورود دومرحله‌ای (پیامکی)</p><p className="mt-1 text-[12.5px] text-[var(--kv-muted)]">{data.twoFactorEnabled ? "فعال است؛ هنگام ورود علاوه بر رمز، کد پیامکی لازم است." : "غیرفعال است. برای امنیت بیشتر فعالش کنید."}</p></div>
        <Btn size="sm" variant={data.twoFactorEnabled ? "soft" : "accent"} onClick={() => setConfirm2fa(!data.twoFactorEnabled)}>{data.twoFactorEnabled ? "غیرفعال‌سازی" : "فعال‌سازی"}</Btn>
      </Card>
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="flex items-center gap-2 text-[15px] font-extrabold"><Monitor size={16} />نشست‌های فعال ({fa(data.sessions.length)})</p>
          <Btn size="sm" variant="soft" icon={<LogOut size={14} />} onClick={async () => { try { await profileApi.logoutAll(); toast.push("از همه دستگاه‌ها خارج شدید."); onLoggedOut(); } catch (e) { toast.push(e instanceof Error ? e.message : "خطا", "error"); } }}>خروج از همه دستگاه‌ها</Btn></div>
        <ul className="divide-y divide-[var(--kv-line)]">
          {data.sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[var(--kv-surface-2)]">{/iOS|اندروید/.test(s.device_label) ? <Smartphone size={16} /> : <Monitor size={16} />}</span>
              <div className="min-w-0 flex-1"><p className="text-[13px] font-bold">{s.device_label}{s.current && <span className="mr-2 rounded-full bg-[#E7F0E6] px-2 py-0.5 text-[10.5px] text-[#3E6B4A]">همین دستگاه</span>}</p><p className="text-[11.5px] text-[var(--kv-muted)]">آخرین فعالیت {formatPersianDateTime(s.last_active_at)}{s.ip_address && ` · ${s.ip_address}`}</p></div>
              {!s.current && <Btn size="sm" variant="ghost" onClick={async () => { await profileApi.revokeSession(s.id); toast.push("نشست بسته شد."); await load(); }}>خروج</Btn>}
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-5">
        <p className="mb-3 text-[15px] font-extrabold">تاریخچه ورود</p>
        <ul className="space-y-2 text-[12.5px]">
          {data.loginHistory.map((h) => <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-[var(--kv-surface-2)]/60 px-3 py-2"><span>{h.device_label} · {h.method === "password+sms_otp" ? "رمز + پیامک" : "رمز عبور"}</span><span className={cn("font-bold", h.succeeded ? "text-[var(--kv-success)]" : "text-[var(--kv-danger)]")}>{h.succeeded ? "موفق" : "ناموفق"}</span><span className="text-[var(--kv-muted)]">{formatPersianDateTime(h.created_at)}</span></li>)}
          {data.loginHistory.length === 0 && <li className="text-[var(--kv-muted)]">سابقه‌ای ثبت نشده است.</li>}
        </ul>
      </Card>
      <Modal open={confirm2fa !== null} onClose={() => { setConfirm2fa(null); setPassword(""); }} max="max-w-[420px]" title="تأیید رمز عبور">
        <div className="space-y-4 pl-10">
          <p className="text-[16px] font-extrabold">{confirm2fa ? "فعال‌سازی" : "غیرفعال‌سازی"} ورود دومرحله‌ای</p>
          <Field label="رمز عبور فعلی"><Input type="password" value={password} onChange={setPassword} /></Field>
          <Btn variant="accent" className="w-full" disabled={!password} onClick={async () => {
            try { await profileApi.setTwoFactor(Boolean(confirm2fa), password); toast.push(confirm2fa ? "ورود دومرحله‌ای فعال شد." : "ورود دومرحله‌ای غیرفعال شد."); setConfirm2fa(null); setPassword(""); await load(); }
            catch (e) { toast.push(e instanceof Error ? e.message : "خطا", "error"); }
          }}>تأیید</Btn>
        </div>
      </Modal>
    </div>
  );
}

/* ============================ Coupons, styles, reviews, invoices, timeline ============================ */

export function CouponWallet() {
  const { data, error, load } = useLoad(accountApi.coupons);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  const active = data.items.filter((c) => !c.used && !c.expired);
  return (
    <div className="space-y-5">
      <div><h2 className="text-[21px] font-extrabold">کوپن‌های من</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">کوپن‌های اختصاصی (تولد، وفاداری، کمپین‌ها) که CRM برای شما صادر کرده است.</p></div>
      {data.items.length === 0 ? <Empty title="کوپنی ندارید" desc="کوپن‌های تولد و وفاداری به‌صورت خودکار اینجا قرار می‌گیرند." /> : (
        <><div className="grid gap-3 md:grid-cols-2">{active.map((c) => <CouponCard key={c.id} c={c} />)}</div>
          {data.items.length > active.length && <><p className="pt-2 text-[13px] font-bold text-[var(--kv-muted)]">استفاده‌شده یا منقضی</p><div className="grid gap-3 md:grid-cols-2">{data.items.filter((c) => c.used || c.expired).map((c) => <CouponCard key={c.id} c={c} />)}</div></>}</>
      )}
    </div>
  );
}

export function SavedStylesCenter({ onStudio, onAddItems }: { onStudio: () => void; onAddItems?: (lines: { id: string; size: string; color: string }[]) => void }) {
  const toast = useToast();
  const { data, error, load } = useLoad(styleApi.list);
  const [preview, setPreview] = useState<SavedStyle | null>(null);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  const edit = (s: SavedStyle) => { sessionStorage.setItem("kolbe-edit-style", s.id); onStudio(); };
  const buy = async (s: SavedStyle) => {
    try {
      const res = await styleApi.validate(s.items.map((i) => ({ productId: i.productId, variantId: i.variantId ?? null })));
      const ok = res.items.filter((i) => i.purchasable && i.variant);
      if (ok.length && onAddItems) { onAddItems(ok.map((i) => ({ id: i.productId, size: i.variant!.size ?? "", color: i.variant!.color ?? "" }))); toast.bumpCart(); styleApi.event("style.purchased", s.id); }
      toast.push(res.message, ok.length === res.total ? "success" : ok.length ? "info" : "error");
    } catch (e) { toast.push(e instanceof Error ? e.message : "خطا", "error"); }
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-[21px] font-extrabold">استایل‌های ذخیره‌شده</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">قیمت و موجودی همیشه از سرور و به‌روز است.</p></div><Btn variant="soft" size="sm" icon={<Sparkles size={15} />} onClick={onStudio}>ساخت استایل</Btn></div>
      {data.items.length === 0 ? <Empty title="استایلی ذخیره نشده" desc="در استایل‌بیلدر ترکیب دلخواه را بسازید و ذخیره کنید." action={<Btn variant="accent" size="sm" onClick={onStudio}>رفتن به استایل‌بیلدر</Btn>} /> : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data.items.map((s) => (
            <Card key={s.id} className="overflow-hidden">
              <button onClick={() => setPreview(s)} className="block w-full">
                {s.preview_data_url ? <img src={s.preview_data_url} alt={`پیش‌نمایش ${s.name}`} className="aspect-[4/3] w-full object-cover" />
                  : <div className="grid aspect-[4/3] grid-cols-3 gap-1 bg-[var(--kv-surface-2)] p-2">{(s.products ?? []).slice(0, 3).map((p) => p.image && <img key={p.id} src={mediaSrc(p.image)} alt="" className="h-full w-full rounded-[8px] object-cover" />)}</div>}
              </button>
              <div className="p-4">
                <div className="flex items-start justify-between gap-2"><div><p className="text-[14px] font-bold">{s.name}</p><p className="text-[11.5px] text-[var(--kv-muted)]">{fa(s.items.length)} آیتم · امتیاز {fa(s.score)} · نسخه {fa(s.version)} · {s.privacy === "private" ? "خصوصی" : s.privacy === "unlisted" ? "با لینک" : "عمومی"}</p></div>
                  <b className="shrink-0 text-[13px] tabular-nums">{fmtMoney(rialToToman(s.currentBundlePriceRial ?? "0"))}</b></div>
                {!s.allAvailable && <p className="mt-1 text-[11.5px] text-[var(--kv-warning)]">برخی آیتم‌ها ناموجود شده‌اند.</p>}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Btn size="sm" variant="accent" icon={<ShoppingBag size={13} />} onClick={() => buy(s)}>خرید</Btn>
                  <Btn size="sm" variant="soft" onClick={() => edit(s)}>ویرایش</Btn>
                  {s.preview_data_url && <a href={s.preview_data_url} download={`${s.name}.jpg`} className="inline-flex h-9 items-center rounded-[10px] border border-[var(--kv-line)] px-3 text-[12px] font-semibold">دانلود</a>}
                  <Btn size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={async () => { await styleApi.remove(s.id); toast.push("استایل حذف شد."); await load(); }}>حذف</Btn>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Modal open={!!preview} onClose={() => setPreview(null)} title="پیش‌نمایش استایل" max="max-w-[640px]">
        {preview && <div className="pl-10"><p className="text-[16px] font-extrabold">{preview.name}</p>{preview.preview_data_url && <img src={preview.preview_data_url} alt="" className="mt-3 w-full rounded-[14px]" />}{preview.explanation && <p className="mt-3 text-[12.5px] leading-7 text-[var(--kv-muted)]">{preview.explanation}</p>}</div>}
      </Modal>
    </div>
  );
}

export function ReviewCenter() {
  const toast = useToast();
  const { data, error, load } = useLoad(styleApi.myReviews);
  const [draft, setDraft] = useState<{ productId: string; name: string; rating: number; body: string } | null>(null);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  return (
    <div className="space-y-6">
      <div><h2 className="text-[21px] font-extrabold">مرکز نظرات</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">برای خریدهای خود امتیاز و دیدگاه ثبت کنید.</p></div>
      <section><h3 className="mb-3 text-[15px] font-extrabold">محصولاتی که می‌توانم نظر بدهم ({fa(data.reviewable.length)})</h3>
        {data.reviewable.length ? <div className="space-y-2">{data.reviewable.map((r) => <div key={r.product_id} className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 py-3"><div><p className="text-[13.5px] font-bold">{r.name}</p><p className="text-[11.5px] text-[var(--kv-muted)]">سفارش {r.reference}</p></div><Btn size="sm" variant="accent" onClick={() => setDraft({ productId: r.product_id, name: r.name, rating: 5, body: "" })}>ثبت نظر</Btn></div>)}</div>
          : <p className="text-[12.5px] text-[var(--kv-muted)]">محصولی در انتظار نظر ندارید.</p>}</section>
      <section><h3 className="mb-3 text-[15px] font-extrabold">نظرات ثبت‌شده من</h3>
        {data.mine.length ? <div className="space-y-2">{data.mine.map((r) => <div key={r.id} className="rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 py-3"><div className="flex flex-wrap items-center gap-2"><b className="text-[13px]">{r.product_name}</b><span className="text-[#D6A94E]">{"★".repeat(r.rating)}</span><Status value={r.status === "approved" ? "منتشر شده" : r.status === "pending" ? "در انتظار بررسی" : "رد شد"} />{r.verified_purchase && <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#3E6B4A]"><BadgeCheck size={12} />خرید تأییدشده</span>}</div>{r.body && <p className="mt-1.5 text-[12.5px] leading-6 text-[var(--kv-muted)]">{r.body}</p>}</div>)}</div>
          : <p className="text-[12.5px] text-[var(--kv-muted)]">هنوز نظری ثبت نکرده‌اید.</p>}</section>
      <Modal open={!!draft} onClose={() => setDraft(null)} max="max-w-[460px]" title="ثبت نظر">
        {draft && <div className="space-y-4 pl-10"><p className="text-[16px] font-extrabold">{draft.name}</p><StarInput value={draft.rating} onChange={(rating) => setDraft({ ...draft, rating })} />
          <label className="block text-[13px] font-semibold">دیدگاه<textarea rows={4} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} className="mt-2 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 text-[13px] outline-none focus:border-[var(--kv-accent)]" /></label>
          <Btn variant="accent" className="w-full" onClick={async () => { try { await styleApi.submitReview(draft.productId, { rating: draft.rating, body: draft.body }); toast.push("نظر شما ثبت شد."); setDraft(null); await load(); } catch (e) { toast.push(e instanceof Error ? e.message : "خطا", "error"); } }}>ثبت</Btn></div>}
      </Modal>
    </div>
  );
}

const INVOICE_KIND: Record<string, string> = { retail_sale: "فاکتور خرید", wholesale_sale: "فاکتور خرید عمده", refund: "سند بازپرداخت", return_credit: "اعتبار مرجوعی", installment_plan: "برنامه اقساط" };
export function InvoiceCenter() {
  const toast = useToast();
  const { data, error, load } = useLoad(accountApi.invoices);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  const download = async (id: string, reference: string) => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/v1/invoices/${id}/pdf`, { headers: { Authorization: `Bearer ${getAccessToken() ?? ""}` }, credentials: "include" });
      if (!res.ok) throw new Error("دریافت فایل ناموفق بود.");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a"); a.href = url; a.download = `invoice-${reference}.pdf`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { toast.push(e instanceof Error ? e.message : "خطا", "error"); }
  };
  return (
    <div className="space-y-5">
      <div><h2 className="text-[21px] font-extrabold">فاکتورها و اسناد</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">همه فاکتورهای خرید و اسناد بازپرداخت از دامنه رسمی فاکتور.</p></div>
      {data.items.length === 0 ? <Empty title="فاکتوری صادر نشده است" desc="پس از پرداخت سفارش، فاکتور رسمی اینجا قابل دریافت است." /> : (
        <div className="divide-y divide-[var(--kv-line)] rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)]">
          {data.items.map((inv) => <div key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3"><FileText size={18} className="text-[var(--kv-accent)]" /><div className="min-w-0 flex-1"><p className="text-[13.5px] font-bold" dir="ltr">{inv.reference}</p><p className="text-[11.5px] text-[var(--kv-muted)]">{INVOICE_KIND[inv.kind] ?? inv.kind} · {formatPersianDate(inv.issue_date)}</p></div><b className="tabular-nums">{fmtMoney(rialToToman(inv.total_rial))}</b><Btn size="sm" variant="soft" onClick={() => download(inv.id, inv.reference)}>PDF</Btn></div>)}
        </div>
      )}
    </div>
  );
}

const TIMELINE_ICON: Record<string, ReactNode> = { order_placed: <Package size={14} />, order_paid: <BadgeCheck size={14} />, order_shipped: <Truck size={14} />, order_in_transit: <Truck size={14} />, order_delivered: <Package size={14} />, coupon: <Ticket size={14} />, review: <Star size={14} />, style: <Sparkles size={14} /> };
export function CustomerTimelineView() {
  const { data, error, load } = useLoad(accountApi.timeline);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  return (
    <div className="max-w-[680px] space-y-5">
      <div><h2 className="text-[21px] font-extrabold">فعالیت‌های من</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">سفارش‌ها، پرداخت‌ها، کوپن‌ها، نظرات و استایل‌ها به ترتیب زمان.</p></div>
      {data.items.length === 0 ? <Empty title="هنوز فعالیتی ندارید" desc="اولین خرید یا استایل شما اینجا ثبت می‌شود." /> : (
        <ol className="space-y-3 border-r-2 border-[var(--kv-line)] pr-5">
          {data.items.map((i, idx) => <li key={`${i.kind}-${i.ref}-${idx}`} className="relative"><span className="absolute -right-[31px] top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--kv-surface)] text-[var(--kv-accent)] ring-2 ring-[var(--kv-line)]">{TIMELINE_ICON[i.kind] ?? <ArrowLeft size={12} />}</span><p className="text-[13px] font-bold">{i.title}</p><p className="text-[11.5px] text-[var(--kv-muted)]">{formatPersianDateTime(i.at)}</p></li>)}
        </ol>
      )}
    </div>
  );
}
