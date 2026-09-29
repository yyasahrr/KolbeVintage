import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, BadgeCheck, Check, ChevronLeft, Clock, Crown, FileText, Headset, Lock, MapPin,
  Package, Send, ShieldCheck, ShoppingBag, Star, Trash2, Wallet, Store as StoreIcon, Truck,
} from "lucide-react";
import { IMG, fmtMoney, fmtNum, type Product, type SeriesDef } from "../data/catalog";
import { useStore } from "../data/store";
import { KOLBE, BUYER_ADDRESS, limitsOf, describeLimits, type VipPlan } from "../data/platform";
import { useOps } from "../data/ops";
import { apiClient, membershipApi } from "../data/api";
import { ParentOrderCard, SupplierChip } from "../components/orders";
import { Btn, Card, SectionHead, Status, Tag, SearchBox, Swatch, Stepper, Empty, Input, Segmented, Field } from "../components/primitives";
import { cn } from "../utils/cn";

export type VipRole = "guest" | "customer" | "vip";
type Tab = "catalog" | "cart" | "orders" | "membership" | "support";
type Source = "all" | "kolbe" | "others";
type OrderFilter = "all" | "action" | "active" | "done";

const FLOW = ["ثبت سفارش", "تأیید تأمین‌کننده", "پرداخت", "آماده‌سازی و ارسال", "تحویل"];

function PriceLock({ compact }: { compact?: boolean }) {
  return (
    <div className={cn("rounded-[12px] border border-dashed border-[var(--kv-line-strong)] bg-[var(--kv-surface-2)]/50", compact ? "px-3 py-2" : "px-3.5 py-2.5")}>
      <p className="flex items-center gap-1.5 text-[12px] font-bold text-[var(--kv-ink-2)]"><Lock size={13} className="text-[var(--kv-accent)]" />قیمت عمده پس از عضویت</p>
      {!compact && <p className="mt-0.5 text-[11px] text-[var(--kv-muted)]">با تأیید حساب عمده، قیمت هر سری و شرایط تسویه را می‌بینید.</p>}
    </div>
  );
}

/* ============ Wholesale product card ============ */
function VipCard({ p, canSee, onOpen }: { p: Product; canSee: boolean; onOpen: () => void }) {
  const kolbe = p.supplierId === KOLBE.id;
  return (
    <article className="kv-card-hover flex flex-col overflow-hidden rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] kv-shadow-sm">
      <button onClick={onOpen} className="relative block w-full text-right" aria-label={p.name}>
        <div className="kv-img kv-img-zoom aspect-[4/3] overflow-hidden">
          <img src={p.images[0]} alt={p.name} loading="lazy" className="h-full w-full object-cover" />
        </div>
        <span className="absolute right-3 top-3"><SupplierChip id={p.supplierId} name={p.supplier} /></span>
      </button>
      <div className="flex flex-1 flex-col p-4">
        <button onClick={onOpen} className="text-right text-[14.5px] font-bold leading-6 transition-colors hover:text-[var(--kv-accent)]">{p.name}</button>
        <p className="mt-1 text-xs text-[var(--kv-muted)]">{kolbe ? "تولید و تأمین مستقیم کلبه" : `تأمین‌کننده: ${p.supplier}`} · {p.sku}</p>
        <div className="mt-2.5 flex items-center gap-1.5">
          {p.colors.slice(0, 4).map((c) => <span key={c.id} title={c.name} className="h-4 w-4 rounded-full border border-black/15" style={{ background: c.hex }} />)}
          <span className="mr-1 text-[11px] text-[var(--kv-muted)]">{fmtNum(p.colors.length)} رنگ</span>
        </div>
        <div className="mt-3">
          {canSee ? (
            <div className="rounded-[12px] bg-[var(--kv-surface-2)]/70 px-3.5 py-2.5">
              <p className="text-[11.5px] text-[var(--kv-muted)]">قیمت عمده از</p>
              <p className="text-[15px] font-extrabold tabular-nums text-[var(--kv-accent)]">{fmtMoney(p.wholesaleFrom)} <span className="text-[11px] font-semibold text-[var(--kv-muted)]">/ سری</span></p>
            </div>
          ) : <PriceLock compact />}
        </div>
        <div className="mt-2.5 flex items-center justify-between text-[12px] text-[var(--kv-muted)]">
          <span>{fmtNum(p.seriesCount)} نوع سری</span>
          <span>حداقل سفارش: <b className="text-[var(--kv-ink)]">{fmtNum(p.moq)} سری</b></span>
        </div>
        <div className="mt-auto pt-3.5"><Btn variant={canSee ? "dark" : "soft"} size="sm" className="w-full" onClick={onOpen}>{canSee ? "مشاهده و سفارش" : "مشاهده جزئیات"}</Btn></div>
      </div>
    </article>
  );
}

function PlanCard({ plan, current, cta, onPick }: { plan: VipPlan; current?: boolean; cta?: string; onPick?: () => void }) {
  return (
    <Card className={cn("flex flex-col p-6", plan.recommended && "border-[var(--kv-accent)]/50", current && "ring-2 ring-[var(--kv-accent)]/30")}>
      <div className="flex items-center justify-between">
        <p className="text-[17px] font-extrabold">{plan.name}</p>
        {current ? <Status value="فعال" /> : plan.recommended ? <span className="rounded-full bg-[var(--kv-accent)]/12 px-2.5 py-1 text-[11px] font-bold text-[var(--kv-accent)]">پیشنهاد کلبه</span> : null}
      </div>
      <p className="mt-3 text-[22px] font-extrabold tabular-nums">{plan.yearly === 0 ? "رایگان" : fmtMoney(plan.yearly)}{plan.yearly > 0 && <span className="text-xs font-medium text-[var(--kv-muted)]"> / سال</span>}</p>
      <p className="text-xs text-[var(--kv-muted)]">{plan.creditLimit ? `سقف اعتبار: ${fmtMoney(plan.creditLimit)}` : "بدون اعتبار · پرداخت آنلاین هر زیرسفارش"}</p>
      <ul className="mt-4 flex-1 space-y-2 text-[13px]">
        {[...describeLimits(plan), ...plan.features].map((f) => <li key={f} className="flex items-center gap-2"><Check size={14} className="shrink-0 text-[var(--kv-success)]" />{f}</li>)}
      </ul>
      {onPick && cta && <Btn variant={plan.recommended ? "accent" : "soft"} className="mt-5 w-full" onClick={onPick}>{cta}</Btn>}
    </Card>
  );
}

/* ============ Wholesale PDP ============ */
export function VipPDP({ p, canSee, role, onBack, onAdd, onAuth, onGoCart }: {
  p: Product; canSee: boolean; role: VipRole; onBack: () => void;
  onAdd: (s: SeriesDef, qty: number, color: string) => void; onAuth: () => void; onGoCart: () => void;
}) {
  const [img, setImg] = useState(0);
  const [color, setColor] = useState(p.colors[0]);
  const first = p.series.find((s) => s.available && p.stock >= s.pieces * s.moqSeries && (!s.colorIds || s.colorIds.includes(color.id))) ?? p.series[0];
  const [seriesId, setSeriesId] = useState(first?.id ?? "");
  const [qty, setQty] = useState(first?.moqSeries ?? 1);
  const [added, setAdded] = useState(false);
  const colorSeries = p.series.filter((s) => !s.colorIds || s.colorIds.includes(color.id));
  const series = colorSeries.find((s) => s.id === seriesId) ?? colorSeries.find((s) => s.available && p.stock >= s.pieces * s.moqSeries) ?? colorSeries[0];
  const pieces = (series?.pieces ?? 0) * qty;
  const total = (series?.pricePerSeries ?? 0) * qty;
  const meetsMoq = !!series && qty >= series.moqSeries;
  const kolbe = p.supplierId === KOLBE.id;

  return (
    <div className="animate-[fadeUp_0.4s_ease]">
      <button onClick={onBack} className="kv-press mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--kv-muted)] hover:text-[var(--kv-ink)]">
        <ChevronLeft size={16} className="rotate-180" /> بازگشت به بازارچه عمده
      </button>
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex gap-3">
          <div className="flex w-[76px] shrink-0 flex-col gap-2.5">
            {p.images.map((im, i) => (
              <button key={i} onClick={() => setImg(i)} className={cn("overflow-hidden rounded-[12px] border-2 transition-all", img === i ? "border-[var(--kv-accent)]" : "border-[var(--kv-line)] opacity-70 hover:opacity-100")}>
                <img src={im} alt="" className="aspect-[3/4] w-full object-cover" />
              </button>
            ))}
          </div>
          <div className="kv-img relative flex-1 overflow-hidden rounded-[24px] border border-[var(--kv-line)] kv-shadow-md">
            <img key={img} src={p.images[img]} alt={p.name} className="aspect-[3/4] w-full object-cover animate-[fadeIn_0.35s_ease]" />
            <span className="absolute right-4 top-4"><SupplierChip id={p.supplierId} name={p.supplier} size="md" /></span>
          </div>
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-3 text-[13px] text-[var(--kv-muted)]">
            <span>{kolbe ? "تأیید و ارسال توسط تیم عملیات کلبه" : `تأیید و ارسال توسط ${p.supplier}`}</span>
            {p.reviews > 0 && <span className="flex items-center gap-1"><Star size={12} fill="#D6A94E" strokeWidth={0} /><b className="text-[var(--kv-ink)]">{p.rating.toLocaleString("fa-IR")}</b> ({fmtNum(p.reviews)})</span>}
            <span className="tabular-nums" dir="ltr">{p.sku}</span>
          </div>
          <h1 className="kv-editorial-title mt-2 text-[26px] md:text-[30px]">{p.name}</h1>
          <p className="mt-2 text-[13px] leading-7 text-[var(--kv-muted)]">{p.desc}</p>

          <div className="mt-5">
            <p className="mb-2.5 text-[13px] font-bold">رنگ <span className="font-medium text-[var(--kv-muted)]">— {color.name}</span></p>
            <div className="flex gap-2.5">{p.colors.map((c) => <Swatch key={c.id} hex={c.hex} name={c.name} selected={color.id === c.id} onSelect={() => { const next = p.series.find((s) => s.available && p.stock >= s.pieces * s.moqSeries && (!s.colorIds || s.colorIds.includes(c.id))) ?? p.series.find((s) => !s.colorIds || s.colorIds.includes(c.id)); setColor(c); setSeriesId(next?.id ?? ""); setQty(next?.moqSeries ?? 1); setAdded(false); }} />)}</div>
          </div>

          <div className="mt-5">
            <p className="mb-2.5 text-[13px] font-bold">انتخاب سری <span className="font-medium text-[var(--kv-muted)]">— ترکیب سایز هر سری ثابت است</span></p>
            <div className="grid gap-2.5 sm:grid-cols-3">
              {colorSeries.map((s) => (
                <button
                  key={s.id} disabled={!s.available || p.stock < s.pieces * s.moqSeries} onClick={() => { setSeriesId(s.id); setQty(s.moqSeries); }}
                  className={cn("kv-press relative rounded-[14px] border p-3.5 text-right transition-all",
                    series.id === s.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06] shadow-[var(--shadow-soft-sm)]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]",
                    (!s.available || p.stock < s.pieces * s.moqSeries) && "opacity-50")}
                >
                  {series.id === s.id && <span className="absolute left-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--kv-accent)] text-white"><Check size={12} /></span>}
                  <p className="text-[13.5px] font-bold">{s.name}</p>
                  <p className="mt-1 text-xs text-[var(--kv-muted)]">{fmtNum(s.pieces)} تکه در هر سری</p>
                  {canSee
                    ? <p className="mt-1.5 text-[12.5px] font-extrabold tabular-nums">{fmtMoney(s.pricePerSeries)}<span className="font-medium text-[var(--kv-muted)]"> / سری</span></p>
                    : <p className="mt-1.5 flex items-center gap-1 text-[11.5px] font-semibold text-[var(--kv-muted)]"><Lock size={11} />قیمت پس از عضویت</p>}
                  <p className="mt-1 text-[11px] text-[var(--kv-muted)]">{!s.available ? "غیرفعال" : p.stock < s.pieces * s.moqSeries ? "موجودی برای حداقل سفارش کافی نیست" : `حداقل ${fmtNum(s.moqSeries)} سری`}</p>
                </button>
              ))}
            </div>
            {!colorSeries.length && <p className="rounded-[11px] bg-[var(--kv-surface-2)] px-3 py-2 text-[12px] text-[var(--kv-muted)]">برای این رنگ سری قابل سفارش تعریف نشده است.</p>}
          </div>

          {series && <div className="mt-4 rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/50 p-4">
            <p className="mb-2.5 text-[12.5px] font-bold text-[var(--kv-muted)]">ترکیب سری «{series.name}»</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(series.composition).filter(([, n]) => n > 0).map(([size, n]) => (
                <span key={size} className="rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 py-1.5 text-[12.5px] font-bold tabular-nums">{size} <span className="text-[var(--kv-accent)]">×{fmtNum(n)}</span></span>
              ))}
            </div>
          </div>}

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <div>
              <p className="mb-2 text-[13px] font-bold">تعداد سری</p>
              <Stepper value={qty} onChange={setQty} min={1} />
            </div>
            <div className="rounded-[12px] bg-[var(--kv-surface-2)]/70 px-4 py-2.5 text-[13px]">
              <span className="text-[var(--kv-muted)]">مجموع: </span><b className="tabular-nums">{fmtNum(pieces)} تکه</b>
              {canSee && <><span className="mx-2 text-[var(--kv-faint)]">·</span><b className="tabular-nums text-[var(--kv-accent)]">{fmtMoney(total)}</b></>}
            </div>
          </div>
          {series && !meetsMoq && <p className="mt-2 text-xs font-semibold text-[var(--kv-danger)]">حداقل سفارش این سری {fmtNum(series.moqSeries)} سری است.</p>}

          {canSee ? (
            <div className="sticky bottom-4 z-10 mt-5 flex flex-wrap gap-2.5 lg:static">
              <Btn variant="accent" size="lg" className="flex-1 shadow-[var(--shadow-soft-lg)] lg:shadow-none" disabled={!meetsMoq || !series?.available || p.stock < pieces || p.stock < (series?.pieces ?? 0) * (series?.moqSeries ?? 0)} icon={<ShoppingBag size={17} />} onClick={() => { if (series) { onAdd(series, qty, color.name); setAdded(true); } }}>
                افزودن به سبد عمده · {fmtMoney(total)}
              </Btn>
              {added && <Btn variant="dark" size="lg" onClick={onGoCart} icon={<ArrowLeft size={16} />}>سبد و ثبت سفارش</Btn>}
            </div>
          ) : (
            <div className="mt-5 rounded-[16px] border border-[var(--kv-accent)]/30 bg-[var(--kv-accent)]/[0.06] p-4">
              <p className="flex items-center gap-2 text-[14px] font-extrabold"><Lock size={16} className="text-[var(--kv-accent)]" />قیمت و ثبت سفارش فقط برای اعضای عمده</p>
              <p className="mt-1 text-[12.5px] leading-6 text-[var(--kv-muted)]">
                {role === "customer"
                  ? "با درخواست عضویت عمده در همین حساب و تأیید مدارک، قیمت هر سری و شرایط تسویه را می‌بینید."
                  : "با همان حساب کلبه وارد شوید، سپس درخواست عضویت عمده بدهید. ورود جداگانه‌ای وجود ندارد."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Btn variant="accent" size="sm" onClick={onAuth} icon={<Crown size={14} />}>درخواست عضویت در همین حساب</Btn>
                {role === "guest" && <Btn variant="soft" size="sm" onClick={onAuth}>ورود به حساب کلبه</Btn>}
              </div>
            </div>
          )}

          <ol className="mt-4 grid grid-cols-5 gap-1 text-center">
            {FLOW.map((f, i) => (
              <li key={f} className="rounded-[10px] bg-[var(--kv-surface-2)]/70 px-1 py-2 text-[10.5px] font-bold leading-4">
                <span className="block text-[var(--kv-accent)] tabular-nums">{fmtNum(i + 1)}</span>{f}
              </li>
            ))}
          </ol>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kv-surface-2)] px-3 py-1.5 text-xs font-semibold"><ShieldCheck size={13} /> تضمین تأمین کلبه</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kv-surface-2)] px-3 py-1.5 text-xs font-semibold"><Clock size={13} /> پاسخ تأمین‌کننده زیر ۲۴ ساعت</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kv-surface-2)] px-3 py-1.5 text-xs font-semibold"><FileText size={13} /> پیش‌فاکتور رسمی</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ MAIN ============ */
export default function VipExperience({ role, buyer, accountId, selectedId, setSelectedId, onAuth }: {
  role: VipRole; buyer: string; accountId?: string; selectedId: string | null; setSelectedId: (id: string | null) => void; onAuth: () => void;
}) {
  const store = useStore();
  const { products, orders, plans, shipping, buyers } = store;
  const wcart = store.wcart.filter((line) => line.accountId === accountId);
  void useEffect; // used above
  const ops = useOps();
  // Wholesale catalog is server-backed: GET /wholesale/products requires active membership (limits). Public sees store cache; VIP sees server auth price.
  const [wholesaleServer, setWholesaleServer] = useState<Product[] | null>(null);
  const [vipLoading, setVipLoading] = useState(false);
  const [vipError, setVipError] = useState<string | null>(null);
  const [serverPlans, setServerPlans] = useState<VipPlan[] | null>(null);
  const [serverMembership, setServerMembership] = useState<any | null>(null);
  const effectivePlans = serverPlans ?? plans;
  const myPlan = effectivePlans.find((p) => p.id === (serverMembership?.planId ?? buyers.find((b) => b.name === buyer)?.planId ?? "gold")) ?? effectivePlans[0];
  const L = limitsOf(myPlan);
  const canSee = role === "vip" && L.showPrices;
  const sourceLocked = role === "vip" && L.sources === "kolbe";
  const custRestrict = accountId ? ops.restrictionFor("customer", accountId) : null;
  const [couponInput, setCouponInput] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [tab, setTab] = useState<Tab>("catalog");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("همه");
  const [source, setSource] = useState<Source>("all");
  const [orderFilter, setOrderFilter] = useState<OrderFilter>("all");
  const [shipId, setShipId] = useState("");
  const [address, setAddress] = useState(BUYER_ADDRESS);
  const [toast, setToast] = useState<string | null>(null);
  const [justPlaced, setJustPlaced] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3400); };
  const marketBase = products.filter((p) => p.status === "published" && p.wholesaleFrom > 0);
  const market = wholesaleServer ?? marketBase;
  const selected = useMemo(() => market.find((p) => p.id === selectedId) ?? null, [selectedId, market]);
  // Server state for membership/plans: authoritative pricing/limits/credit
  useEffect(()=>{ if(role!=="vip") return; let cancel=false; (async()=>{ setVipLoading(true); setVipError(null);
    try{
      const [wh, pl, mem] = await Promise.all([
        membershipApi.wholesaleProducts().catch(()=>null),
        apiClient.get<{ items: VipPlan[] }>("/plans").catch(()=>null),
        membershipApi.current().catch(()=>null),
      ]);
      if(cancel) return;
      if(wh && (wh as any).items) {
        // Map backend wholesale items to Product shape where possible; keep store products as fallback for images/series
        const mapped: Product[] = (wh as any).items.map((row:any)=> {
          const local = marketBase.find(m=> m.id===row.id || m.sku===row.sku);
          if(local) return { ...local, wholesaleFrom: row.wholesale_price_rial ? Number(row.wholesale_price_rial)/10 : local.wholesaleFrom };
          return { id: row.id, sku: row.sku, name: row.name ?? row.product_name ?? "محصول", brand: row.brand ?? "", supplier: row.supplier_id ?? "کلبه", supplierId: row.supplier_id ?? "kolbe", category: row.category ?? "عمومی", retailPrice: 0, wholesaleFrom: row.wholesale_price_rial ? Number(row.wholesale_price_rial)/10 : 0, rating:0, reviews:0, colors:[], images:[IMG.neutralRack], series:[], seriesCount:0, moq:1, stock: 100, fabric:"", desc:"", status:"published" } as unknown as Product;
        });
        if(mapped.length) setWholesaleServer(mapped);
      }
      if(pl && (pl as any).items) setServerPlans((pl as any).items);
      if(mem) setServerMembership(mem);
    } catch(e){ if(!cancel) setVipError(e instanceof Error? e.message : "خطا"); }
    finally{ if(!cancel) setVipLoading(false); }
  })(); return ()=>{ cancel=true; } }, [role]);
  const cats = ["همه", ...Array.from(new Set(market.map((p) => p.category)))];
  const filtered = market.filter((p) => (cat === "همه" || p.category === cat) && (!q.trim() || p.name.includes(q.trim()) || p.supplier.includes(q.trim())));
  const kolbeList = filtered.filter((p) => p.supplierId === KOLBE.id);
  const otherList = filtered.filter((p) => p.supplierId !== KOLBE.id);

  const myOrders = orders.filter((o) => o.accountId ? o.accountId === accountId : o.buyer === buyer);
  const actionCount = myOrders.reduce((a, o) => a + (o.subOrders ?? []).filter((s) => s.status === "approved").length, 0);
  const wholesaleShipping = shipping.filter((s) => s.active && s.scope !== "خرده");
  const chosenShip = wholesaleShipping.find((s) => s.id === shipId) ?? wholesaleShipping[0];

  const cartLines = store.wcart.map((l, i) => {
    const p = products.find((x) => x.id === l.productId);
    const s = p?.series.find((x) => x.id === l.seriesId);
    return l.accountId === accountId && p && s ? { i, l, p, s } : null;
  }).filter((x): x is { i: number; l: typeof wcart[number]; p: Product; s: SeriesDef } => !!x);
  const groups = Array.from(cartLines.reduce((m, c) => { m.set(c.p.supplierId, [...(m.get(c.p.supplierId) ?? []), c]); return m; }, new Map<string, typeof cartLines>()).entries())
    .sort(([a], [b]) => (a === KOLBE.id ? -1 : b === KOLBE.id ? 1 : 0));
  const cartTotal = cartLines.reduce((a, c) => a + c.s.pricePerSeries * c.l.qtySeries, 0);
  const cartPieces = cartLines.reduce((a, c) => a + c.s.pieces * c.l.qtySeries, 0);

  const daysAgo = (label: string) => { const t = label.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776)); const n = Number(t.match(/\d+/)?.[0] ?? 1); return t.includes("ماه") ? 30 * n : t.includes("هفته") ? 7 * n : t.includes("دیروز") ? 1 : t.includes("روز") ? n : 0; };
  const ordersThisMonth = myOrders.filter((o) => daysAgo(o.createdAt) < 30).length;
  const today = new Date().toISOString().slice(0, 10);
  const wCoupon = ops.coupons.find((c) => c.code === couponCode && c.channel === "wholesale");
  const wCouponError = !couponCode ? "" : !wCoupon ? "کوپن عمده‌ای با این کد پیدا نشد." : !wCoupon.active || wCoupon.expires < today ? "این کوپن فعال نیست." : wCoupon.used >= wCoupon.maxUses ? "ظرفیت کوپن تکمیل شده." : cartTotal < wCoupon.minOrder ? `حداقل خرید ${fmtMoney(wCoupon.minOrder)} است.` : "";
  const couponPct = wCoupon && !wCouponError ? wCoupon.value : 0;
  const discountPct = Math.min(60, L.discountPercent + couponPct);
  const discountAmount = Math.round(cartTotal * discountPct / 100);
  const payable = cartTotal - discountAmount;
  const violations = [
    custRestrict?.block || custRestrict?.noWholesale ? `خرید عمده برای حساب شما محدود شده است${custRestrict.reason ? `: ${custRestrict.reason}` : ""}` : "",
    L.maxOrdersPerMonth !== null && ordersThisMonth >= L.maxOrdersPerMonth ? `سقف ${fmtNum(L.maxOrdersPerMonth)} سفارش ماهانه پلن ${myPlan?.name} پر شده است` : "",
    L.maxOrderValue !== null && payable > L.maxOrderValue ? `مبلغ سفارش از سقف ${fmtMoney(L.maxOrderValue)} پلن ${myPlan?.name} بیشتر است` : "",
    L.maxSuppliersPerOrder !== null && groups.length > L.maxSuppliersPerOrder ? `پلن ${myPlan?.name} حداکثر ${fmtNum(L.maxSuppliersPerOrder)} تأمین‌کننده در هر سفارش را مجاز می‌داند` : "",
    sourceLocked && cartLines.some((c) => c.p.supplierId !== KOLBE.id) ? "پلن شما فقط خرید از کلبه وینتیج را شامل می‌شود؛ اقلام سایر تأمین‌کنندگان را حذف کنید" : "",
  ].filter(Boolean);

  const filteredOrders = myOrders.filter((o) => {
    if (orderFilter === "action") return o.subOrders.some((s) => s.status === "approved");
    if (orderFilter === "active") return o.subOrders.some((s) => !["delivered", "rejected", "cancelled"].includes(s.status));
    if (orderFilter === "done") return o.subOrders.every((s) => ["delivered", "rejected", "cancelled"].includes(s.status));
    return true;
  });

  const nav: { v: Tab; label: string; icon: React.ReactNode; badge?: number }[] = canSee
    ? [
      { v: "catalog", label: "بازارچه", icon: <Package size={16} /> },
      { v: "cart", label: "سبد عمده", icon: <ShoppingBag size={16} />, badge: wcart.length },
      { v: "orders", label: "سفارش‌ها", icon: <FileText size={16} />, badge: actionCount },
      { v: "membership", label: "عضویت", icon: <Crown size={16} /> },
      { v: "support", label: "پشتیبانی", icon: <Headset size={16} /> },
    ]
    : [
      { v: "catalog", label: "بازارچه", icon: <Package size={16} /> },
      { v: "membership", label: "پلن‌های عضویت", icon: <Crown size={16} /> },
    ];

  const placeOrder = () => {
    if (!chosenShip) return;
    if (!accountId) return;
    if (violations.length) return;
    const id = store.placeOrder(buyer, chosenShip.name, address, accountId, discountPct);
    if (wCoupon && couponPct) ops.upsert("coupons", { ...wCoupon, used: wCoupon.used + 1 });
    setCouponCode(""); setCouponInput("");
    setJustPlaced(id);
    setTab("orders");
    setOrderFilter("all");
    flash(`سفارش ${id} ثبت شد و به ${fmtNum(groups.length)} تأمین‌کننده ارسال شد`);
  };

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-20 pt-6 md:px-8">
      {/* sub nav */}
      <div className="kv-glass sticky top-[68px] z-30 -mx-1 mb-6 flex items-center gap-1.5 overflow-x-auto rounded-[16px] p-1.5 kv-no-scrollbar">
        {nav.map((n) => (
          <button key={n.v} onClick={() => { setTab(n.v); setSelectedId(null); }} className={cn("kv-press flex items-center gap-2 whitespace-nowrap rounded-[11px] px-4 py-2 text-[13.5px] font-bold transition-all", tab === n.v && !selected ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527] shadow" : "text-[var(--kv-ink-2)] hover:bg-[var(--kv-surface-2)]")}>
            {n.icon}{n.label}
            {!!n.badge && <span className="rounded-full bg-[var(--kv-accent)] px-1.5 py-0.5 text-[10px] font-bold text-white tabular-nums">{fmtNum(n.badge)}</span>}
          </button>
        ))}
        {canSee
          ? <span className="mr-auto hidden items-center gap-1.5 whitespace-nowrap rounded-full bg-[#E7F0E6] px-3 py-1.5 text-xs font-bold text-[#3E6B4A] md:inline-flex dark:bg-[#3E6B4A]/20 dark:text-[#7FB08C]"><BadgeCheck size={14} /> {buyer} · پلن {myPlan?.name}</span>
          : <button onClick={onAuth} className="mr-auto hidden items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--kv-accent)]/12 px-3 py-1.5 text-xs font-bold text-[var(--kv-accent)] md:inline-flex"><Lock size={13} /> قیمت‌ها پس از عضویت عمده</button>}
      </div>

      {selected ? (
        <VipPDP
          p={selected} canSee={canSee && !(sourceLocked && selected.supplierId !== KOLBE.id)} role={role}
          onBack={() => setSelectedId(null)} onAuth={onAuth}
          onAdd={(s, qty, color) => { if (!accountId) return; store.wcartAdd({ accountId, productId: selected.id, seriesId: s.id, color, qtySeries: qty }); flash(`${fmtNum(qty)} سری «${selected.name}» به سبد عمده اضافه شد`); }}
          onGoCart={() => { setSelectedId(null); setTab("cart"); }}
        />
      ) : tab === "catalog" ? (
        <div className="animate-[fadeUp_0.4s_ease]">
          {vipLoading && <div className="mb-3 rounded-[12px] bg-[var(--kv-surface-2)] px-4 py-2 text-xs text-[var(--kv-muted)]">در حال بارگذاری کاتالوگ عمده…</div>}
          {vipError && <div className="mb-3 rounded-[12px] border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{vipError} <button onClick={()=>window.location.reload()} className="underline">تلاش دوباره</button></div>}
          <section className="relative overflow-hidden rounded-[24px] border border-[var(--kv-line)] kv-shadow-md">
            <img src={IMG.neutralRack} alt="" className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-l from-[#0E1527]/88 via-[#0E1527]/62 to-[#0E1527]/20" />
            <div className="relative p-8 md:p-12">
              <p className="kv-latin text-[11px] text-[#E8D9C3]">KOLBE WHOLESALE</p>
              <h1 className="kv-editorial-title mt-3 max-w-[22ch] text-[26px] text-[#FAF6EF] md:text-[36px]">بازارچه عمده کلبه — محصولات خودمان و تأمین‌کنندگان منتخب</h1>
              <p className="mt-3 max-w-[56ch] text-sm leading-7 text-[#D8D2C2]">هر سفارش به تفکیک تأمین‌کننده ثبت می‌شود، تأمین‌کننده امکان تأمین را تأیید می‌کند و بعد پرداخت، آماده‌سازی و ارسال هر بخش جداگانه پیش می‌رود.</p>
              <div className="mt-5 flex flex-wrap gap-2">
                {["سری‌بندی شفاف و حداقل سفارش مشخص", "تأیید مستقل هر تأمین‌کننده", "پرداخت امن از طریق کلبه"].map((t) => (
                  <span key={t} className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3.5 py-1.5 text-xs font-bold text-white backdrop-blur-md"><Check size={13} />{t}</span>
                ))}
              </div>
            </div>
          </section>

          {!canSee && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-[var(--kv-accent)]/30 bg-[var(--kv-accent)]/[0.06] px-5 py-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--kv-accent)]/15 text-[var(--kv-accent)]"><Lock size={17} /></span>
                <div>
                  <p className="text-[14px] font-extrabold">بازارچه برای همه باز است؛ قیمت‌ها فقط برای اعضای عمده</p>
                  <p className="mt-0.5 text-[12.5px] leading-6 text-[var(--kv-muted)]">{role === "customer" ? "حساب شما حساب خرید خرده است. با تأیید عضویت عمده، قیمت هر سری را می‌بینید و می‌توانید سفارش ثبت کنید." : "محصولات، سری‌ها و حداقل سفارش را ببینید؛ برای قیمت و ثبت سفارش، عضو عمده شوید."}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Btn variant="accent" size="sm" onClick={onAuth} icon={<Crown size={14} />}>درخواست عضویت در همین حساب</Btn>
                <Btn variant="soft" size="sm" onClick={() => setTab("membership")}>مقایسه پلن‌ها</Btn>
              </div>
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            <div className="min-w-[220px] flex-1"><SearchBox value={q} onChange={setQ} placeholder="جست‌وجوی محصول یا تأمین‌کننده…" /></div>
            <Segmented<Source> options={[{ v: "all", label: "همه" }, { v: "kolbe", label: "کلبه وینتیج" }, { v: "others", label: "سایر تأمین‌کنندگان" }]} value={source} onChange={setSource} />
          </div>
          <div className="kv-no-scrollbar mt-3.5 flex gap-2 overflow-x-auto pb-1">
            {cats.map((c) => <Tag key={c} active={cat === c} onClick={() => setCat(c)}>{c}</Tag>)}
          </div>

          {(source === "all" || source === "kolbe") && (
            <section className="mt-8">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="kv-editorial-title flex items-center gap-2.5 text-[22px]"><span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#1B2A4A] text-[#E8D9C3] dark:bg-[#E8D9C3] dark:text-[#0E1527]"><StoreIcon size={17} /></span>محصولات عمده کلبه وینتیج</h2>
                  <p className="mt-1.5 text-sm text-[var(--kv-muted)]">تولید و تأمین مستقیم کلبه؛ تأیید و ارسال توسط تیم عملیات ما · {fmtNum(kolbeList.length)} محصول</p>
                </div>
              </div>
              {kolbeList.length === 0 ? <Empty title="محصولی پیدا نشد" desc="فیلترها را تغییر دهید." /> : (
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {kolbeList.map((p) => <VipCard key={p.id} p={p} canSee={canSee} onOpen={() => setSelectedId(p.id)} />)}
                </div>
              )}
            </section>
          )}

          {(source === "all" || source === "others") && (
            <section className="mt-10">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="kv-editorial-title text-[22px]">محصولات عمده سایر تأمین‌کنندگان</h2>
                  <p className="mt-1.5 max-w-[70ch] text-sm leading-7 text-[var(--kv-muted)]">تأمین‌کنندگان تأییدشده‌ای که در بازارچه کلبه می‌فروشند. هر سفارش مستقیماً برای تأمین‌کننده ارسال و توسط او تأیید می‌شود؛ پرداخت و تضمین از طریق کلبه است · {fmtNum(otherList.length)} محصول</p>
                </div>
              </div>
              {otherList.length === 0 ? <Empty title="محصولی پیدا نشد" desc="فیلترها را تغییر دهید." /> : (
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {sourceLocked && <div className="col-span-full rounded-[14px] border border-[var(--kv-accent)]/30 bg-[var(--kv-accent)]/[0.06] p-4 text-[13px] leading-7">قیمت و خرید محصولات سایر تأمین‌کنندگان در پلن {myPlan?.name} فعال نیست. <button onClick={() => setTab("membership")} className="font-bold text-[var(--kv-accent)] underline">ارتقای پلن</button></div>}
                  {otherList.map((p) => <VipCard key={p.id} p={p} canSee={canSee && !sourceLocked} onOpen={() => setSelectedId(p.id)} />)}
                </div>
              )}
            </section>
          )}
        </div>
      ) : tab === "cart" ? (
        <div className="animate-[fadeUp_0.35s_ease]">
          <SectionHead title="سبد عمده" desc="اقلام به تفکیک تأمین‌کننده گروه‌بندی می‌شوند؛ هر گروه یک زیرسفارش مستقل با تأیید، پرداخت و ارسال جداگانه خواهد بود." />
          {cartLines.length === 0 ? (
            <Empty title="سبد عمده خالی است" desc="از بازارچه، سری و رنگ مورد نظر را انتخاب کنید و به سبد اضافه کنید." action={<Btn variant="accent" size="sm" onClick={() => setTab("catalog")}>رفتن به بازارچه</Btn>} />
          ) : (
            <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
              <div className="space-y-4">
                {groups.map(([sid, lines], gi) => {
                  const sub = lines.reduce((a, c) => a + c.s.pricePerSeries * c.l.qtySeries, 0);
                  return (
                    <Card key={sid} className="overflow-hidden">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 px-5 py-3">
                        <div className="flex items-center gap-2"><span className="text-[11px] font-bold text-[var(--kv-faint)]">زیرسفارش {fmtNum(gi + 1)}</span><SupplierChip id={sid} name={lines[0].p.supplier} /></div>
                        <b className="text-[13.5px] tabular-nums">{fmtMoney(sub)}</b>
                      </div>
                      <div className="divide-y divide-[var(--kv-line)]">
                        {lines.map((c) => (
                          <div key={c.i} className="flex flex-wrap items-center gap-4 px-5 py-4">
                            <img src={c.p.images[0]} alt="" className="h-20 w-16 rounded-[10px] object-cover" />
                            <div className="min-w-0 flex-1">
                              <button onClick={() => setSelectedId(c.p.id)} className="text-[14px] font-bold hover:text-[var(--kv-accent)]">{c.p.name}</button>
                              <p className="mt-0.5 text-xs text-[var(--kv-muted)]">{c.s.name} ({fmtNum(c.s.pieces)} تکه) · {c.l.color} · {fmtMoney(c.s.pricePerSeries)} / سری</p>
                              {c.l.qtySeries < c.s.moqSeries && <p className="mt-1 text-[11.5px] font-bold text-[var(--kv-danger)]">حداقل سفارش این سری {fmtNum(c.s.moqSeries)} سری است</p>}
                            </div>
                            <Stepper value={c.l.qtySeries} onChange={(v) => store.wcartQty(c.i, v)} min={1} />
                            <div className="w-32 text-left"><p className="text-[14px] font-extrabold tabular-nums">{fmtMoney(c.s.pricePerSeries * c.l.qtySeries)}</p><p className="text-[11px] text-[var(--kv-muted)]">{fmtNum(c.s.pieces * c.l.qtySeries)} تکه</p></div>
                            <button onClick={() => store.wcartRemove(c.i)} className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label="حذف"><Trash2 size={17} /></button>
                          </div>
                        ))}
                      </div>
                      <p className="bg-[var(--kv-surface-2)]/40 px-5 py-2.5 text-[11.5px] text-[var(--kv-muted)]">{sid === KOLBE.id ? "این بخش توسط تیم عملیات کلبه تأیید و ارسال می‌شود." : `این بخش برای ${lines[0].p.supplier} ارسال می‌شود و پس از تأیید او قابل پرداخت است.`}</p>
                    </Card>
                  );
                })}
                <Btn variant="ghost" size="sm" onClick={() => setTab("catalog")} icon={<ArrowLeft size={14} className="rotate-180" />}>ادامه انتخاب از بازارچه</Btn>
              </div>

              <Card className="h-fit p-6 lg:sticky lg:top-[150px]">
                <p className="text-[15px] font-bold">ثبت سفارش</p>
                <div className="mt-4 space-y-2.5 text-[13px]">
                  <div className="flex justify-between text-[var(--kv-muted)]"><span>تأمین‌کنندگان</span><b className="text-[var(--kv-ink)] tabular-nums">{fmtNum(groups.length)} → {fmtNum(groups.length)} زیرسفارش</b></div>
                  <div className="flex justify-between text-[var(--kv-muted)]"><span>مجموع تکه‌ها</span><b className="text-[var(--kv-ink)] tabular-nums">{fmtNum(cartPieces)}</b></div>
                  <div className="flex justify-between text-[var(--kv-muted)]"><span>جمع سری‌ها</span><span className="tabular-nums">{fmtMoney(cartTotal)}</span></div>
                  {L.discountPercent > 0 && <div className="flex justify-between text-[var(--kv-success)]"><span>تخفیف پلن {myPlan?.name} ({fmtNum(L.discountPercent)}٪)</span><span className="tabular-nums">−{fmtMoney(Math.round(cartTotal * L.discountPercent / 100))}</span></div>}
                  {couponPct > 0 && <div className="flex justify-between text-[var(--kv-success)]"><span>کوپن {wCoupon?.code} ({fmtNum(couponPct)}٪)</span><span className="tabular-nums">−{fmtMoney(Math.round(cartTotal * couponPct / 100))}</span></div>}
                  <div className="flex justify-between border-t border-[var(--kv-line)] pt-3 text-[15px] font-extrabold"><span>مبلغ کل</span><span className="tabular-nums">{fmtMoney(payable)}</span></div>
                  <div className="pt-1"><div className="flex gap-2"><input aria-label="کد تخفیف عمده" value={couponInput} onChange={(e) => setCouponInput(e.target.value)} placeholder="کد تخفیف عمده" dir="ltr" className="h-10 min-w-0 flex-1 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[12.5px] uppercase text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]" /><Btn size="sm" variant="soft" disabled={!couponInput.trim()} onClick={() => setCouponCode(couponInput.trim().toUpperCase())}>اعمال</Btn></div>{wCouponError && <p className="mt-1 text-[11.5px] text-[var(--kv-danger)]">{wCouponError}</p>}</div>
                  <div className="rounded-[11px] bg-[var(--kv-surface-2)]/60 p-3 text-[11.5px] leading-6 text-[var(--kv-muted)]">پلن {myPlan?.name}: {L.maxOrdersPerMonth !== null ? `${fmtNum(ordersThisMonth)} از ${fmtNum(L.maxOrdersPerMonth)} سفارش این ماه` : "سفارش ماهانه نامحدود"}{L.maxOrderValue !== null ? ` · سقف هر سفارش ${fmtMoney(L.maxOrderValue)}` : ""}{L.maxSuppliersPerOrder !== null ? ` · حداکثر ${fmtNum(L.maxSuppliersPerOrder)} تأمین‌کننده` : ""}</div>
                </div>
                <div className="mt-5 space-y-3">
                  <Field label="روش ارسال">
                    <div className="space-y-1.5">
                      {wholesaleShipping.map((m) => (
                        <button key={m.id} onClick={() => setShipId(m.id)} className={cn("flex w-full items-center gap-2.5 rounded-[11px] border px-3 py-2.5 text-right text-[12.5px] transition-all", chosenShip?.id === m.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.05]" : "border-[var(--kv-line)]")}>
                          <Truck size={15} className="shrink-0 text-[var(--kv-muted)]" />
                          <span className="flex-1"><b>{m.name}</b><span className="block text-[11px] text-[var(--kv-muted)]">{m.eta}</span></span>
                          <span className="text-[11.5px] font-bold">{L.freeShipping ? "رایگان · مزیت پلن" : m.price === 0 ? "پس‌کرایه" : fmtMoney(m.price)}</span>
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label="نشانی تحویل"><Input value={address} onChange={setAddress} icon={<MapPin size={15} />} /></Field>
                </div>
                {violations.length > 0 && <ul role="alert" className="mt-4 space-y-1 rounded-[11px] bg-[var(--kv-danger)]/[0.06] p-3 text-[12px] leading-6 text-[var(--kv-danger)]">{violations.map((v) => <li key={v}>• {v}</li>)}<li><button onClick={() => setTab("membership")} className="font-bold underline">مقایسه و ارتقای پلن</button></li></ul>}
                <Btn variant="accent" size="lg" className="mt-5 w-full" icon={<Send size={16} />} disabled={violations.length > 0 || cartLines.some((c) => c.l.qtySeries < c.s.moqSeries)} onClick={placeOrder}>ثبت سفارش و ارسال به تأمین‌کنندگان</Btn>
                <p className="mt-3 text-[11.5px] leading-5 text-[var(--kv-muted)]">هنوز پرداختی انجام نمی‌شود. بعد از تأیید هر تأمین‌کننده، پرداخت همان بخش فعال می‌شود{myPlan?.creditLimit ? ` یا از اعتبار پلن ${myPlan.name} استفاده می‌کنید` : ""}.</p>
              </Card>
            </div>
          )}
        </div>
      ) : tab === "orders" ? (
        <div className="animate-[fadeUp_0.35s_ease]">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="kv-editorial-title text-[22px] md:text-[26px]">سفارش‌های عمده</h2>
              <p className="mt-1.5 max-w-[64ch] text-sm leading-7 text-[var(--kv-muted)]">هر سفارش مادر شامل زیرسفارش‌هایی به تفکیک تأمین‌کننده است؛ روی فلش بزنید تا وضعیت مستقل هر بخش را ببینید.</p>
            </div>
            <Segmented<OrderFilter> options={[{ v: "all", label: "همه" }, { v: "action", label: "نیازمند پرداخت" }, { v: "active", label: "در جریان" }, { v: "done", label: "بسته‌شده" }]} value={orderFilter} onChange={setOrderFilter} />
          </div>
          {filteredOrders.length === 0 ? (
            <Empty title="سفارشی در این دسته نیست" desc="وقتی از بازارچه سفارش ثبت کنید، اینجا با جزئیات هر زیرسفارش نمایش داده می‌شود." action={<Btn variant="accent" size="sm" onClick={() => setTab("catalog")}>رفتن به بازارچه</Btn>} />
          ) : (
            <div className="space-y-3">
              {filteredOrders.map((o) => (
                <ParentOrderCard
                  key={o.id} order={o} perspective="buyer" defaultOpen={o.id === justPlaced || o.id === filteredOrders[0].id}
                  onPaySub={(sid) => { store.paySub(o.id, sid, buyer); flash(`زیرسفارش ${sid} پرداخت شد؛ تأمین‌کننده آماده‌سازی را شروع می‌کند`); }}
                  onPayAll={() => { store.payParent(o.id, buyer); flash(`همه بخش‌های تأییدشده سفارش ${o.id} پرداخت شد`); }}
                  onCancelSub={(sid) => { store.transitionSub(o.id, sid, "cancelled", buyer); flash(`زیرسفارش ${sid} لغو شد`); }}
                />
              ))}
            </div>
          )}
        </div>
      ) : tab === "membership" ? (
        <div className="animate-[fadeUp_0.35s_ease]">
          {canSee ? (
            <>
              <SectionHead title="عضویت عمده" desc="پلن فعلی، اعتبار و پلن‌های قابل ارتقا." />
              <Card className="overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-4 bg-[#1B2A4A] p-6 text-[#F5EFE3]">
                  <div className="flex items-center gap-4">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#E8D9C3]/15"><Crown size={22} className="text-[#E8D9C3]" /></span>
                    <div><p className="text-lg font-extrabold">پلن {myPlan?.name}</p><p className="text-[13px] text-[#B9C4D8]">{buyer} · فعال تا ۱۴ اسفند ۱۴۰۴</p></div>
                  </div>
                  <Status value="فعال" />
                </div>
                <div className="grid gap-4 p-6 sm:grid-cols-3">
                  {[["سقف اعتبار", myPlan?.creditLimit ? fmtMoney(myPlan.creditLimit) : "—", <Wallet key="w" size={17} />], ["مانده اعتبار", myPlan?.creditLimit ? fmtMoney(Math.round(myPlan.creditLimit * 0.42)) : "—", <ShieldCheck key="s" size={17} />], ["سفارش‌های من", `${fmtNum(myOrders.length)} سفارش`, <Package key="p" size={17} />]].map(([l, v, icon]) => (
                    <div key={l as string} className="rounded-[14px] border border-[var(--kv-line)] p-4">
                      <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[var(--kv-surface-2)] text-[var(--kv-accent)]">{icon as React.ReactNode}</span>
                      <p className="mt-2.5 text-[15px] font-extrabold tabular-nums">{v as string}</p>
                      <p className="text-xs text-[var(--kv-muted)]">{l as string}</p>
                    </div>
                  ))}
                </div>
              </Card>
              <p className="mb-3 mt-8 text-[15px] font-extrabold">پلن‌های عضویت</p>
              <div className="grid gap-4 md:grid-cols-3">
                {effectivePlans.filter((p) => p.active).map((p) => <PlanCard key={p.id} plan={p} current={p.id === myPlan?.id} cta={p.id === myPlan?.id ? undefined : "درخواست تغییر پلن"} onPick={p.id === myPlan?.id ? undefined : () => flash(`درخواست تغییر به پلن ${p.name} برای کارشناس حساب ارسال شد`)} />)}
              </div>
              <Card className="mt-5 p-6">
                <p className="mb-3 text-sm font-bold">نشانی‌های تحویل</p>
                {[[BUYER_ADDRESS, "پیش‌فرض"], ["انبار مرکزی — تهران، جاده قدیم کرج", ""]].map(([a, d]) => (
                  <div key={a} className="mb-2 flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3">
                    <p className="flex items-center gap-2 text-[13px]"><MapPin size={15} className="text-[var(--kv-muted)]" />{a}</p>
                    {d && <span className="rounded-full bg-[var(--kv-surface-2)] px-2.5 py-1 text-[11px] font-bold">{d}</span>}
                  </div>
                ))}
              </Card>
            </>
          ) : (
            <>
              <SectionHead title="پلن‌های عضویت عمده" desc="بعد از ثبت درخواست و تأیید مدارک کسب‌وکار (معمولاً یک روز کاری)، قیمت‌های عمده و ثبت سفارش فعال می‌شود." />
              <div className="grid gap-4 md:grid-cols-3">
                {effectivePlans.filter((p) => p.active).map((p) => <PlanCard key={p.id} plan={p} cta="درخواست عضویت" onPick={onAuth} />)}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="mx-auto max-w-[720px] animate-[fadeUp_0.35s_ease]">
          <SectionHead title="پشتیبانی تجاری" desc="کارشناسان عمده کلبه شنبه تا پنجشنبه، ۹ تا ۱۸ پاسخ‌گویند. میانگین پاسخ: ۳ ساعت." />
          <Card className="p-6">
            <div className="space-y-3">
              <div className="rounded-[14px] bg-[var(--kv-surface-2)]/70 p-4 text-[13px] leading-7">سلام! کارشناس حساب شما هستم. زیرسفارش WO-1002-1 توسط فراسو تأیید شده و منتظر پرداخت شماست. اگر می‌خواهید از اعتبار پلن استفاده کنید، اطلاع دهید.</div>
              <div className="mr-8 rounded-[14px] bg-[var(--kv-action)] p-4 text-[13px] leading-7 text-[var(--kv-bg)] dark:text-[#0E1527]">ممنون. زیرسفارش نیلگون در همان سفارش هنوز تأیید نشده؛ پیگیری می‌کنید؟</div>
              <div className="rounded-[14px] bg-[var(--kv-surface-2)]/70 p-4 text-[13px] leading-7">بله، برای نیلگون یادآوری فرستادم. مهلت پاسخ تأمین‌کننده ۲۴ ساعت است.</div>
            </div>
            <div className="mt-4 flex gap-2">
              <Input placeholder="پیام خود را بنویسید…" className="flex-1" />
              <Btn variant="accent" icon={<Send size={16} />} onClick={() => flash("پیام ارسال شد")}>ارسال</Btn>
            </div>
          </Card>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-1/2 z-[90] translate-x-1/2 animate-[scaleIn_0.25s_ease]">
          <div className="kv-glass flex items-center gap-2.5 rounded-[14px] px-5 py-3.5 text-[13.5px] font-bold shadow-lg">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--kv-success)] text-white"><Check size={15} /></span>
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}
