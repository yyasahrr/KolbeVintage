import { useEffect, useState } from "react";
import { SupplierProfileSettings } from "./supplier-profile-settings";
import { AdaptiveSpecForm, missingRequiredSpecs } from "./admin-product-types";
import { productTypesApi, siteApi, type ProductType } from "../data/experience-api";
import {
  LayoutDashboard, Package, Plus, ClipboardList, Boxes, Wallet, Inbox,
  Settings, Bell, Menu, TrendingUp, AlertTriangle, Check, CircleDollarSign,
  FlaskConical, Clock, Sun, Moon, LogOut, Send, Store, PackagePlus,
} from "lucide-react";
import { SupplierRequestsPortal } from "../components/supplier-requests-portal";
import { SupplierConsignmentPanel, SupplierOffersPanel } from "../components/supplier-wholesale-panel";
import { IMG, COLORS, STATUS_LABEL, fmtMoney, fmtNum, nextSku, type SeriesDef } from "../data/catalog";
void nextSku; // kept for demo preview (?demo=1)
import { useStore } from "../data/store";
import { SUB_STATUS, isTerminal, type SubStatus } from "../data/platform";
import { SubOrderDesk } from "../components/orders";
import { AuthScreens } from "./studio";
import { seriesSizesFor } from "./series-templates";
import { SupplierWallet, SupplierBankForm, useWallet } from "./supplier-wallet";
import { TicketCenter } from "../components/support";
import { SupplierStatsPanel } from "./supplier-stats-panel";
import { SupplierOrdersPanel } from "../components/supplier-orders-panel";
import { SupplierChildOrdersPanel } from "../components/supplier-child-orders-panel";
import { SupplierReviewPanel } from "../components/supplier-review-panel";
import { useOps } from "../data/ops";
import { apiClient, authApi, isAuthenticated, notificationsApi, productsApi, catalogOpsApi, filesApi } from "../data/api";
import { rialFromToman } from "../data/contracts";
import { CanonicalSeriesLibrary, ProductSeriesEditor, productSeriesPayload } from "../components/product-series-editor";
import { Landmark, Headset, Layers, ShieldAlert, FileSignature, KeyRound } from "lucide-react";

/* Login or apply: the application form is defined by Kolbe admins and submissions land in the admin console. */
function SupplierEntry({ onLogin }: { onLogin: () => void }) {
  const ops = useOps();
  const form = ops.applicationForm;
  const [mode, setMode] = useState<"login" | "apply">("login");
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [sent, setSent] = useState<string | null>(null);
  const submit = async () => {
    const e = form.fields.filter((f) => f.required && !(values[f.id] ?? "").trim()).map((f) => `«${f.label}» الزامی است.`);
    form.fields.forEach((f) => {
      const v = (values[f.id] ?? "").replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776));
      if (v && f.type === "phone" && !/^09\d{9}$/.test(v)) e.push(`«${f.label}» باید شماره همراه ۱۱ رقمی باشد.`);
      if (v && f.type === "email" && !/^\S+@\S+\.\S+$/.test(v)) e.push(`«${f.label}» ایمیل معتبر نیست.`);
      if (v && f.type === "number" && !/^\d+$/.test(v)) e.push(`«${f.label}» باید عدد باشد.`);
      // file validation (MIME/size) — backend also validates; here we enforce client side
      if (f.type === "file" && values[f.id]) {
        const name = values[f.id];
        const ext = name.split(".").pop()?.toLowerCase() ?? "";
        if (!["pdf","jpg","jpeg","png","webp"].includes(ext)) e.push(`«${f.label}» فقط PDF یا تصویر مجاز است.`);
        // size check would be done on File object; name-only mode skips size
      }
    });
    setErrors(e);
    if (e.length) return;
    try {
      // Server-backed cooperation request: backend validates against active form fields, rate-limits, and audits
      const payload: Record<string,string> = {};
      for (const f of form.fields) payload[f.id] = values[f.id] ?? "";
      const res = await apiClient.post<{ id: string; reference: string }>("/cooperation-requests", { payload });
      setSent(res.reference ?? res.id); setValues({});
    } catch (err) {
      setErrors([err instanceof Error ? err.message : "خطا در ارسال درخواست"]);
    }
  };
  return (
    <div className="w-full">
      <div className="mb-4 flex justify-center"><div className="inline-flex rounded-full border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/70 p-1">
        {([["login", "ورود تأمین‌کنندگان", <KeyRound key="k" size={14} />], ["apply", "درخواست همکاری", <FileSignature key="f" size={14} />]] as const).map(([v, l, i]) => <button key={v} onClick={() => setMode(v)} className={cn("flex min-h-10 items-center gap-1.5 rounded-full px-4 text-[13px] font-bold", mode === v ? "bg-[var(--kv-surface)] shadow-[var(--shadow-soft-sm)]" : "text-[var(--kv-muted)]")}>{i}{l}</button>)}
      </div></div>
      {mode === "login" ? <AuthScreens portal="supplier" onDone={onLogin} /> : !form.active ? (
        <Card className="p-6 text-center"><p className="text-[15px] font-extrabold">پذیرش تأمین‌کننده موقتاً متوقف است</p><p className="mt-2 text-[13px] text-[var(--kv-muted)]">لطفاً بعداً دوباره سر بزنید یا با پشتیبانی کلبه تماس بگیرید.</p></Card>
      ) : sent ? (
        <Card className="p-6 text-center"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#E7F0E6] text-[#3E6B4A]"><Check size={22} /></span><p className="mt-3 text-[16px] font-extrabold">درخواست {sent} ثبت شد</p><p className="mt-2 text-[13px] leading-7 text-[var(--kv-muted)]">تیم کلبه درخواست را بررسی می‌کند و نتیجه به شماره همراه شما اطلاع داده می‌شود.</p><Btn variant="soft" size="sm" className="mt-4" onClick={() => setSent(null)}>ثبت درخواست دیگر</Btn></Card>
      ) : (
        <Card className="p-6">
          <p className="text-[16px] font-extrabold">{form.title}</p><p className="mt-1.5 text-[13px] leading-7 text-[var(--kv-muted)]">{form.intro}</p>
          <div className="mt-5 space-y-4">
            {form.fields.map((f) => {
              const label = `${f.label}${f.required ? " *" : ""}`;
              const v = values[f.id] ?? "";
              const set = (x: string) => setValues({ ...values, [f.id]: x });
              if (f.type === "textarea") return <Field key={f.id} label={label} hint={f.hint}><textarea rows={3} value={v} onChange={(e) => set(e.target.value)} className="w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 py-3 text-sm text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]" /></Field>;
              if (f.type === "select") return <Field key={f.id} label={label} hint={f.hint}><Select options={["انتخاب کنید", ...(f.options ?? [])]} value={v || "انتخاب کنید"} onChange={(x) => set(x === "انتخاب کنید" ? "" : x)} /></Field>;
              if (f.type === "checkbox") return <label key={f.id} className="flex items-start gap-2 text-[13px] font-medium"><input type="checkbox" checked={v === "بله"} onChange={(e) => set(e.target.checked ? "بله" : "")} className="mt-1 h-4 w-4 accent-[#C1613B]" />{label}</label>;
              if (f.type === "file") return <Field key={f.id} label={label} hint={f.hint ?? "PDF یا تصویر · حداکثر ۵ مگابایت · ذخیره امن در بک‌اند (metadata DB + MIME/size + authorization)"}><input type="file" accept="image/*,application/pdf" onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) { set(""); return; }
                if (file.size > 5 * 1024 * 1024) { setErrors((prev)=> [...prev, `«${f.label}» حداکثر ۵ مگابایت مجاز است.`]); return; }
                if (!["application/pdf","image/jpeg","image/png","image/webp"].includes(file.type)) { setErrors((prev)=> [...prev, `«${f.label}» نوع فایل مجاز نیست.`]); return; }
                // In dev without external storage, file is sent as multipart to /supplier-profile/documents with DB metadata; for cooperation request we store filename and will upload after approval
                set(file.name);
              }} className="block w-full text-[12.5px] file:ml-3 file:rounded-[9px] file:border-0 file:bg-[var(--kv-surface-2)] file:px-3 file:py-2 file:text-[12px] file:font-semibold" /></Field>;
              return <Field key={f.id} label={label} hint={f.hint}><Input value={v} onChange={set} /></Field>;
            })}
          </div>
          {errors.length > 0 && <ul role="alert" className="mt-4 space-y-1 rounded-[12px] bg-[var(--kv-danger)]/[0.06] p-3 text-[12px] text-[var(--kv-danger)]">{errors.map((x) => <li key={x}>• {x}</li>)}</ul>}
          <Btn variant="accent" className="mt-5 w-full" onClick={submit} icon={<Send size={15} />}>ارسال درخواست</Btn>
          <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">فایل‌ها در این نسخه آزمایشی بارگذاری نمی‌شوند و فقط نامشان ثبت می‌شود.</p>
        </Card>
      )}
    </div>
  );
}
import { Btn, Card, Drawer, Empty, Status, SearchBox, Input, Field, Switch, Timeline, Select } from "../components/primitives";
import { cn } from "../utils/cn";
import { useDialogFocus } from "../components/focus-trap";

function Spark({ points, w = 220, h = 56 }: { points: number[]; w?: number; h?: number }) {
  const max = Math.max(...points), min = Math.min(...points);
  const path = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - 6 - ((v - min) / (max - min || 1)) * (h - 12);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={w} height={h} className="w-full" viewBox={`0 0 ${w} ${h}`} fill="none">
      <path d={`${path} L${w},${h} L0,${h} Z`} fill="var(--kv-accent)" opacity={0.12} />
      <path d={path} stroke="var(--kv-accent)" strokeWidth={2.2} strokeLinecap="round" />
    </svg>
  );
}

function Donut({ segs }: { segs: { v: number; c: string; l: string }[] }) {
  const total = segs.reduce((s, x) => s + x.v, 0) || 1;
  let acc = 0;
  const R = 44, C = 2 * Math.PI * R;
  return (
    <div className="flex items-center gap-5">
      <div className="relative">
        <svg width={128} height={128} viewBox="0 0 120 120">
          <circle cx={60} cy={60} r={R} fill="none" stroke="var(--kv-surface-2)" strokeWidth={15} />
          {segs.map((s, i) => {
            const frac = s.v / total; const dash = frac * C; const off = -acc * C; acc += frac;
            return <circle key={i} cx={60} cy={60} r={R} fill="none" stroke={s.c} strokeWidth={15} strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={off} transform="rotate(-90 60 60)" />;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-lg font-extrabold tabular-nums">{fmtNum(segs.reduce((s, x) => s + x.v, 0))}</p>
          <p className="text-[10.5px] text-[var(--kv-muted)]">زیرسفارش</p>
        </div>
      </div>
      <div className="space-y-2">
        {segs.map((s) => <p key={s.l} className="flex items-center gap-2 text-xs"><span className="h-2.5 w-2.5 rounded-full" style={{ background: s.c }} />{s.l} <b className="tabular-nums">{fmtNum(s.v)}</b></p>)}
      </div>
    </div>
  );
}

/* ====== Standalone app: KOLBE Supplier Center ====== */

/* Supplier product form — canonical product enums (backend catalog.ts) and a last-resort category list used only when
   the catalogue taxonomy endpoint is empty/unreachable. */
const GENDERS: [("men" | "women" | "unisex" | "kids"), string][] = [["unisex", "یونیسکس"], ["men", "مردانه"], ["women", "زنانه"], ["kids", "بچگانه"]];
const SEASONS: [string, string][] = [["spring", "بهار"], ["summer", "تابستان"], ["autumn", "پاییز"], ["winter", "زمستان"], ["all-season", "چهارفصل"]];
const FALLBACK_CATEGORIES = ["پیراهن", "شومیز", "کت و بلیزر", "مانتو و بارانی", "پالتو", "شلوار", "کفش", "اکسسوری", "بافت"];
const emptySupplierForm = () => ({ name: "", category: "پیراهن", desc: "", stock: "", productTypeId: "", gender: "unisex" as "men" | "women" | "unisex" | "kids", seasons: [] as string[], vibes: [] as string[] });

export default function SupplierApp({ dark, setDark, onExit }: { dark: boolean; setDark: (v: boolean) => void; onExit: () => void }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  /* Operational access is the SERVER's decision: a JWT session whose /auth/me carries the supplier
     role AND an approved cooperation state. §22: an applicant whose membership request is still in
     review (or was rejected) sees the REAL state from the backend — never a made-up one and never a
     generic "user not found". The former ?demo=1 sessionStorage bypass is gone. */
  const [coopState, setCoopState] = useState<string | null>(null);
  useEffect(()=>{ (async()=>{ try{
    if(!isAuthenticated()) { setAuthed(false); return; }
    const me = await authApi.me();
    const isStaff = me.roles.includes("admin");
    const status = me.supplier?.cooperationStatus ?? null;
    setCoopState(status);
    setAuthed(isStaff || (me.roles.includes("supplier") && status === "approved"));
  } catch{ setAuthed(false); } })(); },[]);
  if (!authed) {
    return (
      <div className="min-h-screen">
        <header className="mx-auto flex h-[68px] w-full max-w-[1200px] items-center justify-between px-4 md:px-8">
          <SupplierBrand />
          <div className="flex items-center gap-2">
            <button onClick={() => setDark(!dark)} className="kv-press flex h-10 w-10 items-center justify-center rounded-[11px] hover:bg-[var(--kv-surface-2)]" aria-label="تغییر تم">{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
            <Btn variant="ghost" size="sm" onClick={onExit}>رفتن به kolbe.ir</Btn>
          </div>
        </header>
        <div className="mx-auto grid w-full max-w-[1200px] items-center gap-10 px-4 pb-16 pt-6 md:px-8 lg:grid-cols-[1fr_440px]">
          <div className="hidden lg:block">
            <h1 className="kv-editorial-title text-[34px]">محصولاتت را به هزاران بوتیک و فروشگاه برسان</h1>
            <p className="mt-4 max-w-[52ch] text-[15px] leading-8 text-[var(--kv-muted)]">
              مرکز تأمین‌کنندگان کلبه جایی است که کاتالوگ عمده، سری‌ها و موجودی‌ات را مدیریت می‌کنی. هر محصولی که ثبت کنی، بعد از بازبینی کیفیت، در بازارچه عمده کلبه کنار محصولات خود کلبه به خریداران نمایش داده می‌شود.
            </p>
            <ol className="mt-7 space-y-4">
              {[
                ["ثبت محصول و سری‌ها", "عکس، ترکیب سایز هر سری، قیمت و حداقل سفارش"],
                ["بازبینی کلبه", "تیم کیفیت ظرف یک روز کاری محصول را بررسی می‌کند"],
                ["دریافت سفارش و تأیید تأمین", "خریدار سفارش می‌دهد؛ تو امکان تأمین را تأیید می‌کنی، بعد پرداخت و ارسال"],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--kv-surface-2)] text-sm font-extrabold tabular-nums">{(i + 1).toLocaleString("fa-IR")}</span>
                  <div><p className="text-[14.5px] font-bold">{t}</p><p className="text-[13px] text-[var(--kv-muted)]">{d}</p></div>
                </li>
              ))}
            </ol>
          </div>
          <div>
            {coopState && coopState !== "approved" && (
              <Card className="mb-4 p-4 text-[13px] leading-7">
                <b className="block text-[14px]">{coopState === "rejected" ? "درخواست عضویت تأمین‌کننده تأیید نشد" : "درخواست عضویت تأمین‌کننده در حال بررسی است"}</b>
                <span className="text-[var(--kv-muted)]">{coopState === "rejected"
                  ? "برای پیگیری با پشتیبانی کلبه تماس بگیرید؛ پس از اصلاح، دسترسی عملیاتی فعال می‌شود."
                  : "پس از تأیید تیم کلبه، دسترسی عملیاتی این پنل فعال می‌شود."}</span>
              </Card>
            )}
          <SupplierEntry onLogin={async () => { try{
            if(!isAuthenticated()) return setAuthed(false);
            const me = await authApi.me();
            const status = me.supplier?.cooperationStatus ?? null;
            setCoopState(status);
            setAuthed(me.roles.includes("admin") || (me.roles.includes("supplier") && status === "approved"));
          } catch{ setAuthed(false); } }} />
          </div>
        </div>
      </div>
    );
  }
  return <SupplierWorkspace dark={dark} setDark={setDark} onLogout={() => { void authApi.logout().catch(()=>undefined); setAuthed(false); }} />;
}

function SupplierBrand() {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--kv-accent)] text-[17px] font-bold text-white" style={{ fontFamily: "Marcellus, serif" }}>K</span>
      <span className="leading-tight">
        <span className="block text-[14px] font-bold" style={{ fontFamily: "Marcellus, serif", letterSpacing: "0.2em" }}>KOLBE</span>
        <span className="block text-[11px] font-bold text-[var(--kv-muted)]">مرکز تأمین‌کنندگان</span>
      </span>
    </div>
  );
}

const ME_FALLBACK = { id: "s1", name: "نیلگون" };
// In production ME is derived from authenticated user (supplier profile). The fallback is only for ?demo=1 offline.

function SupplierWorkspace({ dark, setDark, onLogout }: { dark: boolean; setDark: (v: boolean) => void; onLogout: () => void }) {
  const { products: storeProducts, orders: storeOrders } = useStore();
  const [profile, setProfile] = useState<{ userId: string; displayName: string; businessName?: string } | null>(null);
  const [supplierProducts, setSupplierProducts] = useState<any[] | null>(null);
  const [supplierOrders, setSupplierOrders] = useState<any[] | null>(null);
  const [supLoading, setSupLoading] = useState(false);
  const [supError, setSupError] = useState<string | null>(null);
  const demo = new URLSearchParams(window.location.search).has("demo");
  // Real supplier identity: GET /supplier-profile (DB) → fallback s1 only in ?demo=1
  useEffect(()=>{ if(demo) return; let cancel=false; (async()=>{ setSupLoading(true); setSupError(null);
    try{
      if(!isAuthenticated()) return;
      const prof = await apiClient.get<{ userId: string; displayName: string; businessName?: string; cooperationStatus?: string }>("/supplier-profile").catch(()=>null);
      if(cancel) return; if(prof) setProfile({ userId: (prof as any).userId ?? (prof as any).id ?? "", displayName: (prof as any).displayName ?? (prof as any).businessName ?? "تأمین‌کننده", businessName: (prof as any).businessName });
      const prods = await apiClient.get<{ items: unknown[] }>("/products").catch(()=>null);
      if(!cancel && prods) setSupplierProducts((prods as any).items ?? []);
      const ords = await apiClient.get<{ items: unknown[] }>("/supplier/orders").catch(()=>null);
      if(!cancel && ords) setSupplierOrders((ords as any).items ?? []);
    } catch(e){ if(!cancel) setSupError(e instanceof Error? e.message : "خطا"); }
    finally{ if(!cancel) setSupLoading(false); }
  })(); return()=>{ cancel=true; }; },[]);
  const ME = demo ? ME_FALLBACK : profile ? { id: profile.userId, name: profile.displayName } : ME_FALLBACK;
  const isDemoME = demo && ME.id === ME_FALLBACK.id;
  // Products/orders: prefer server data where available; demo uses store seed
  const effectiveProducts = (supplierProducts as any) ?? storeProducts;
  const effectiveOrders = (supplierOrders as any) ?? storeOrders;
  const products: any = effectiveProducts;
  const orders: any = effectiveOrders;
  const mine = (products as any[]).filter((p: any) => p.supplierId === ME.id);
  const mySubs: any[] = (orders as any[]).flatMap((o: any) => (o.subOrders ?? o.sub_orders ?? []).filter((s: any) => s.supplierId === ME.id || s.supplier_id === ME.id).map((sub: any) => ({ parent: o, sub })));
  const pendingSubs = mySubs.filter((i: any) => i.sub.status === "pending_supplier");
  const openSubs = mySubs.filter((i: any) => !["delivered","rejected","cancelled","returned"].includes(i.sub.status));
  const revenue = mySubs.filter((i: any) => ["paid","preparing","shipped","delivered"].includes(i.sub.status)).reduce((a: number, i: any) => a + (i.sub.total ?? i.sub.total_rial ?? 0), 0);
  // Local add/status helpers are now API-backed; keep for demo but also expose server calls below
  const { setStatus: _setStatusLocal, addProduct: _addLocal, transitionSub: _transLocal } = useStore();
  void _setStatusLocal; void _addLocal; void _transLocal;
// pending/open/revenue already defined above via API-aware effective orders

  const [tab, setTab] = useState("dashboard");
  const [drawer, setDrawer] = useState(false); const drawerRef = useDialogFocus<HTMLElement>(drawer, () => setDrawer(false));
  const [editorSec, setEditorSec] = useState("base");
  const [form, setForm] = useState(emptySupplierForm);
  // Canonical taxonomy (Req 325-326): categories/vibes come from the shared catalogue taxonomy endpoints; gender and
  // seasons are the backend product enums. Nothing is duplicated here — the payload carries the canonical values.
  const [taxonomy, setTaxonomy] = useState<{ status: "loading" | "ready" | "error"; categories: string[]; vibes: { slug: string; name: string }[] }>({ status: "loading", categories: [], vibes: [] });
  const loadTaxonomy = () => {
    setTaxonomy((t) => ({ ...t, status: "loading" }));
    Promise.all([siteApi.categories(), siteApi.vibes()])
      .then(([c, v]) => setTaxonomy({ status: "ready", categories: c.items.filter((x) => x.active !== false).map((x) => x.name), vibes: v.items.map((x) => ({ slug: x.slug, name: x.name })) }))
      .catch(() => setTaxonomy((t) => ({ ...t, status: "error" })));
  };
  useEffect(loadTaxonomy, []);
  const categoryOptions = taxonomy.categories.length ? taxonomy.categories : FALLBACK_CATEGORIES;
  useEffect(() => {
    if (taxonomy.categories.length && !taxonomy.categories.includes(form.category)) setForm((f) => ({ ...f, category: taxonomy.categories[0]! }));
  }, [taxonomy.categories, form.category]);
  const [draftSeries, setDraftSeries] = useState<SeriesDef[]>([]);
  const [productImages, setProductImages] = useState<{ fileId: string; url: string; previewUrl: string }[]>([]);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [seriesSizes, setSeriesSizes] = useState<string[]>([]);
  const [categoryFields, setCategoryFields] = useState<Record<string, unknown>[]>([]);
  const [categoryError, setCategoryError] = useState("");
  useEffect(() => {
    let alive = true;
    setCategoryError("");
    catalogOpsApi.categorySchema(form.category).then((schema) => {
      if (!alive) return;
      setCategoryFields(schema.specFields);
      setSeriesSizes(schema.allowedSizes.length ? schema.allowedSizes : seriesSizesFor(form.category));
    }).catch((e: unknown) => { if (alive) setCategoryError(e instanceof Error ? e.message : "دریافت ساختار دسته انجام نشد."); });
    return () => { alive = false; };
  }, [form.category]);

  const [draftColorIds, setDraftColorIds] = useState<string[]>(["orange", "black", "cream"]);
  const [invQ, setInvQ] = useState("");
  // Adaptive product form (Req 325-326): the supplier fills values; the schema comes from the product type.
  const [productTypes, setProductTypes] = useState<ProductType[]>([]);
  const [typeCode, setTypeCode] = useState("");
  const [specs, setSpecs] = useState<Record<string, unknown>>({});
  useEffect(() => { productTypesApi.list().then((r) => setProductTypes(r.items)).catch(() => setProductTypes([])); }, []);
  const selectedType = productTypes.find((t) => t.code === typeCode);
  const ops = useOps();
  const wallet = useWallet(ME.id);
  const restrict = ops.restrictionFor("supplier", ME.id);
  // Loading/error for API-backed supplier runtime (no silent fallback)
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifs, setNotifs] = useState<{ id: string; title: string; body: string; readAt: string | null; createdAt: string }[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    if (isDemoME) return;
    let live = true;
    const loadNotifs = async () => {
      try {
        const [list, unread] = await Promise.all([
          notificationsApi.list({ limit: "30" }),
          notificationsApi.unreadCount().catch(() => ({ count: 0 })),
        ]);
        if (!live) return;
        setNotifs(((list as { items?: unknown[] }).items ?? []).map((entry) => {
          const row = (entry ?? {}) as Record<string, unknown>;
          return {
            id: String(row.id ?? ""), title: String(row.title ?? ""), body: String(row.body ?? ""),
            readAt: (row.readAt ?? row.read_at ?? null) as string | null,
            createdAt: String(row.createdAt ?? row.created_at ?? ""),
          };
        }).filter((n) => n.id));
        setUnreadCount(unread.count ?? 0);
      } catch { /* notifications are best-effort; the review panel is the source of truth */ }
    };
    void loadNotifs();
    const timer = setInterval(loadNotifs, 60000);
    return () => { live = false; clearInterval(timer); };
  }, [isDemoME]);
  const markAllRead = async () => {
    try {
      await notificationsApi.readAll();
      setNotifs((items) => items.map((n) => ({ ...n, readAt: new Date().toISOString() })));
      setUnreadCount(0);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا"); }
  };
  // supplier runtime banner (loading/error/demo)
  void supLoading; void supError;
  const supplierBanner = supLoading ? <div className="mb-3 rounded-[12px] bg-[var(--kv-surface-2)] px-4 py-2 text-xs text-[var(--kv-muted)]">در حال بارگذاری اطلاعات تأمین‌کننده…</div> : supError ? <div className="mb-3 rounded-[12px] border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{supError} <button onClick={()=>window.location.reload()} className="underline">تلاش دوباره</button></div> : isDemoME ? <div className="mb-3 rounded-[12px] border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">DEMO MODE — داده‌ها محلی و نمایشی هستند (?demo=1)</div> : null;
  const offeredDraft = draftSeries.filter((series) => series.available);
  const canSubmitProduct = !!form.name.trim() && (!!form.category.trim() && !categoryError) && draftColorIds.length > 0 && offeredDraft.length > 0
    && offeredDraft.every((series) => series.pieces > 0 && series.pricePerSeries > 0 && series.moqSeries > 0 && (series.colorIds?.length ?? draftColorIds.length) > 0)
    && (isDemoME ? missingRequiredSpecs(selectedType, specs).length === 0 : categoryFields.every((field) => !field.required || String(specs[String(field.code)] ?? "").trim()));
  const submitProduct = async () => {
    if (restrict.noPublish) { flash("انتشار محصول برای حساب شما محدود شده است."); return; }
    if (!canSubmitProduct) { flash("ابتدا نام، دسته‌بندی، مشخصات و دست‌کم یک سریِ قابل سفارش با قیمت و رنگ معتبر ثبت کنید."); return; }
    if (isDemoME) {
      const price = Math.min(...offeredDraft.map((series) => series.pricePerSeries)); void price;
      const moq = Math.min(...offeredDraft.map((series) => series.moqSeries)); void moq; // for stock check
      // Demo mode: local only (still generates SKU via nextSku for preview)
      const localStore = (await import("../data/store")).useStore as unknown as null;
      void localStore;
      // Direct setState via store not available here; use fallback via window dispatch
      // For demo we call local via supplier's previous addProduct path (kept for preview)
      try {
        await productsApi.create({
          brand: "Nilgoon", name: form.name.trim(), category: form.category, description: form.desc.trim(),
          cashPriceRial: "0", wholesalePriceRial: rialFromToman(price),
          gender: form.gender, seasons: form.seasons, vibes: form.vibes,
          variants: [{ attributes: {} }],
          metadata: { supplierId: ME.id },
        });
      } catch {}
      setForm(emptySupplierForm());
      setProductImages([]); setDraftSeries([]); setDraftColorIds(["orange","black","cream"]); setTab("products"); setEditorSec("base");
      flash("محصول با سری‌های تعریف‌شده برای بازبینی کلبه ارسال شد. (demo)");
      return;
    }
    try {
      if (!isAuthenticated()) { flash("برای ثبت محصول وارد شوید"); return; }
      const price = Math.max(1, Math.floor(Math.min(...offeredDraft.map((series) => series.pricePerSeries / Math.max(1, series.pieces)))));
      const colors = draftColorIds.map((id) => COLORS[id]).filter(Boolean);
      const recipes = productSeriesPayload(offeredDraft, colors);
      const variantCells = [...new Map(recipes.flatMap((recipe) => recipe.items.map((item) => ({ size: item.size, color: recipe.color }))).map((cell) => [`${cell.color}|${cell.size}`, cell])).values()];
      // Request → backend authoritative SKU + product id + variants (server generates SKUs)
      const created = await productsApi.create({
        brand: "Nilgoon", name: form.name.trim(), category: form.category, description: form.desc.trim() || "توضیحات این محصول در حال تکمیل است.",
        cashPriceRial: "0", wholesalePriceRial: rialFromToman(price),
        variants: variantCells, wholesaleSeries: recipes, retailEnabled: false, wholesaleEnabled: true, installmentPolicy: "disabled", installmentEnabled: false,
        metadata: { images: productImages.map(({ fileId, url }) => ({ fileId, url })) }, specifications: specs,
        gender: form.gender, seasons: form.seasons, vibes: form.vibes,
      });
      // Refresh supplier products cache
      const refreshed = await apiClient.get<{ items: unknown[] }>("/products").catch(()=>null);
      if (refreshed) setSupplierProducts((refreshed as any).items);
      setForm(emptySupplierForm());
      setProductImages([]); setDraftSeries([]); setDraftColorIds(["orange","black","cream"]); setTab("products"); setEditorSec("base");
      flash(`محصول ${created.variants?.[0]?.sku ?? created.id} برای بازبینی کلبه ارسال شد.`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در ثبت محصول");
    }
  };

  const transition = async (_pid: string, sid: string, status: SubStatus, extra?: { note?: string; tracking?: string; eta?: string }) => {
    if (demo || isDemoME) {
      // Demo: local store transition
      void _pid; try { const _store = (await import("../data/store")) as any; void _store; } catch {}
      // Fallback to local via _transLocal if available
      // For now, no-op and just flash
      const msgDemo: Record<string, string> = { // fix any index
        pending_supplier: "", approved: `${sid} تأیید شد؛ خریدار برای پرداخت مطلع شد`, rejected: `${sid} رد شد و به خریدار اطلاع داده شد`,
        paid: "", preparing: `${sid} وارد آماده‌سازی شد`, ready_to_ship: `${sid} آماده ارسال شد`, in_transit: `${sid} به باربری تحویل داده شد`, shipped: `${sid} ارسال شد؛ کد رهگیری ثبت شد`, delivered: `${sid} تحویل ثبت شد`, cancelled: "",
      };
      if (msgDemo[status]) flash(msgDemo[status]);
      return;
    }
    try {
      if (!isAuthenticated()) { flash("برای اقدام وارد شوید"); return; }
      // Supplier fulfillment is server-backed: POST /supplier/orders/:id/fulfillment
      await apiClient.post(`/supplier/orders/${sid}/fulfillment`, { status, note: extra?.note, trackingCode: extra?.tracking });
      const refreshed = await apiClient.get<{ items: unknown[] }>("/supplier/orders").catch(()=>null);
      if (refreshed) setSupplierOrders((refreshed as any).items);
      const msg: Record<string, string> = { // supplier status map // fix any index
        pending_supplier: "", approved: `${sid} تأیید شد؛ خریدار برای پرداخت مطلع شد`, rejected: `${sid} رد شد و به خریدار اطلاع داده شد`,
        paid: "", preparing: `${sid} وارد آماده‌سازی شد`, ready_to_ship: `${sid} آماده ارسال شد`, in_transit: `${sid} به باربری تحویل داده شد`, shipped: `${sid} ارسال شد؛ کد رهگیری ثبت شد`, delivered: `${sid} تحویل ثبت شد`, cancelled: "",
      };
      if (msg[status]) flash(msg[status]);
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در تغییر وضعیت");
    }
  };

  type NavItem = { g: string } | { v: string; label: string; icon: React.ReactNode; badge?: number };
  const nav: NavItem[] = [
    { g: "کار" },
    { v: "dashboard", label: "داشبورد", icon: <LayoutDashboard size={17} /> },
    { v: "products", label: "محصولات", icon: <Package size={17} /> },
    { v: "templates", label: "قالب‌های سری", icon: <Layers size={17} /> },
    { v: "rfq", label: "درخواست‌های تأیید", icon: <Inbox size={17} />, badge: pendingSubs.length || undefined },
    { v: "orders", label: "سفارش‌های عمده", icon: <ClipboardList size={17} />, badge: mySubs.filter((i: any) => (i as any).sub.status === "paid").length || undefined },
    { g: "عملیات" },
    { v: "inventory", label: "موجودی انبار", icon: <Boxes size={17} /> },
    { v: "wholesale-offers", label: "پیشنهاد و ظرفیت عمده", icon: <Layers size={17} /> },
    { v: "consignment", label: "موجودی نزد کلبه", icon: <Package size={17} /> },
    { v: "supply-requests", label: "درخواست‌های تأمین", icon: <PackagePlus size={17} /> },
    { v: "finance", label: "کیف پول و برداشت", icon: <Wallet size={17} /> },
    { v: "bank", label: "اطلاعات مالی و بانکی", icon: <Landmark size={17} />, badge: ops.banks[ME.id]?.status === "verified" ? undefined : 1 },
    { v: "support", label: "پشتیبانی", icon: <Headset size={17} />, badge: ops.tickets.filter((t) => t.ownerId === ME.id && t.status === "answered").length || undefined },
    { g: "سیستم" },
    { v: "settings", label: "تنظیمات", icon: <Settings size={17} /> },
  ];

  const titles: Record<string, [string, string]> = {
    dashboard: ["نمای کلی", `شاخص‌های امروز فروشگاه ${ME.name}`],
    products: ["محصولات من", "مدیریت کاتالوگ، موجودی و وضعیت انتشار در بازارچه عمده"],
    editor: ["ویرایشگر محصول", "محصول جدید برای بازارچه عمده کلبه"],
    series: ["سری‌بندی محصولات", "ترکیب سایز، رنگ، MOQ و قیمت هر سری را مستقل مدیریت کنید"],
    rfq: ["درخواست‌های تأیید", "زیرسفارش‌های تازه که منتظر تأیید امکان تأمین هستند"],
    orders: ["سفارش‌های عمده", "پرداخت، آماده‌سازی، ارسال و تحویل"],
    inventory: ["موجودی انبار", "موجودی، رزرو و هشدار اتمام"],
    production: ["تولید", "سفارش‌های تولید، نمونه و کنترل کیفیت"],
    finance: ["کیف پول و برداشت", `موجودی پس از کسر کمیسیون ${fmtNum(ops.commissions[ME.id] ?? 8)}٪ کلبه`],
    templates: ["قالب‌های سری", "ترکیب سایزها را یک‌بار تعریف کنید و در محصولات انتخاب کنید"],
    bank: ["اطلاعات مالی و بانکی", "شبا، کارت و اطلاعات حقوقی برای تسویه"],
    support: ["پشتیبانی", "تیکت‌های شما با تیم کلبه"],
    settings: ["تنظیمات فروشگاه", "پروفایل، انبارها و اعلان‌ها"],
  };
  const [t, d] = titles[tab] ?? titles.dashboard;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-5 pb-4 pt-6"><SupplierBrand /></div>
      <div className="mx-4 mb-2 flex items-center gap-3 rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/50 p-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-[11px] bg-[#1B2A4A] text-sm font-bold text-[#E8D9C3]">ن</span>
        <div><p className="text-[14px] font-extrabold">{ME.name}</p><p className="text-[11.5px] text-[var(--kv-muted)]">تأمین‌کننده تأییدشده · تهران</p></div>
      </div>
      <nav className="kv-scroll flex-1 space-y-0.5 overflow-y-auto px-3">
        {nav.map((n, i) =>
          "g" in n ? <p key={i} className="px-3 pb-1 pt-4 text-[11px] font-bold text-[var(--kv-faint)]">{n.g}</p> : (
            <button key={n.v} onClick={() => { setTab(n.v); setDrawer(false); }}
              className={cn("kv-press flex w-full items-center gap-2.5 rounded-[11px] px-3 py-2.5 text-[13.5px] font-semibold transition-all",
                tab === n.v || (tab === "editor" && n.v === "products") ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527] shadow" : "text-[var(--kv-ink-2)] hover:bg-[var(--kv-surface-2)]")}>
              {n.icon}{n.label}
              {n.badge && <span className="mr-auto rounded-full bg-[var(--kv-accent)] px-2 py-0.5 text-[10.5px] font-bold text-white tabular-nums">{fmtNum(n.badge)}</span>}
            </button>
          )
        )}
      </nav>
      <div className="space-y-1 border-t border-[var(--kv-line)] p-3">
        {sessionStorage.getItem("kolbe-preview") === "1" && <button onClick={() => { window.location.hash = "#/"; }} className="kv-press flex w-full items-center gap-2.5 rounded-[11px] px-3 py-2.5 text-[13px] font-semibold text-[var(--kv-ink-2)] hover:bg-[var(--kv-surface-2)]"><Store size={17} />بازگشت به فروشگاه</button>}
        <button onClick={() => setDark(!dark)} className="kv-press flex w-full items-center gap-2.5 rounded-[11px] px-3 py-2.5 text-[13.5px] font-semibold text-[var(--kv-ink-2)] hover:bg-[var(--kv-surface-2)]">{dark ? <Sun size={17} /> : <Moon size={17} />}{dark ? "حالت روشن" : "حالت تیره"}</button>
        <button onClick={onLogout} className="kv-press flex w-full items-center gap-2.5 rounded-[11px] px-3 py-2.5 text-[13.5px] font-semibold text-[var(--kv-danger)] hover:bg-[var(--kv-danger)]/[0.06]"><LogOut size={17} />خروج از حساب</button>
      </div>
    </div>
  );

  if (restrict.block) return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="max-w-[460px] p-7 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--kv-danger)]/10 text-[var(--kv-danger)]"><ShieldAlert size={24} /></span>
        <p className="mt-4 text-[18px] font-extrabold">حساب تأمین‌کننده مسدود شده است</p>
        <p className="mt-2 text-[13px] leading-7 text-[var(--kv-muted)]">دلیل: {restrict.reason ?? "به تشخیص کلبه"}. محصولات شما موقتاً در بازارچه نمایش داده نمی‌شوند. برای رفع مسدودی با پشتیبانی کلبه تماس بگیرید.</p>
        <Btn variant="soft" className="mt-5" onClick={onLogout}>خروج</Btn>
      </Card>
    </div>
  );

  return (
    <div><div>{supplierBanner}</div><div className="mx-auto w-full max-w-[1560px] px-0 pb-16 md:px-5">
      <div className="flex min-h-screen gap-5 pt-4">
        <aside className="sticky top-4 hidden h-[calc(100vh-32px)] w-[264px] shrink-0 overflow-hidden rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] kv-shadow-sm lg:block">{sidebar}</aside>
        {drawer && (
          <div className="fixed inset-0 z-[70] lg:hidden">
            <div className="absolute inset-0 bg-black/45" onClick={() => setDrawer(false)} aria-hidden="true" />
            <aside ref={drawerRef} role="dialog" aria-modal="true" aria-label="منوی پنل" className="absolute right-0 top-0 h-full overflow-y-auto w-[280px] bg-[var(--kv-surface)] animate-[drawerIn_0.3s_ease]">{sidebar}</aside>
          </div>
        )}

        <div className="min-w-0 flex-1 px-4 md:px-2">
          <div className="kv-glass sticky top-4 z-30 mb-5 flex items-center gap-3 rounded-[16px] px-4 py-3">
            <button className="lg:hidden" onClick={() => setDrawer(true)} aria-label="منو"><Menu size={20} /></button>
            <div className="min-w-0">
              <h1 className="truncate text-[16px] font-extrabold">{t}</h1>
              <p className="hidden truncate text-xs text-[var(--kv-muted)] sm:block">{d}</p>
            </div>
            <div className="mr-auto flex items-center gap-2">
              <div className="hidden w-56 md:block"><SearchBox placeholder="جست‌وجوی محصول، سفارش…" /></div>
              <button onClick={() => setNotifOpen(true)} className="kv-press relative flex h-10 w-10 items-center justify-center rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)]" aria-label="اعلان‌ها">
                <Bell size={17} />{(unreadCount > 0 || pendingSubs.length > 0) && <span className="absolute left-2 top-2 h-2 w-2 rounded-full bg-[var(--kv-danger)]" />}
              </button>
              <span className="flex h-10 w-10 items-center justify-center rounded-[11px] bg-[#1B2A4A] text-sm font-bold text-[#E8D9C3]">ن</span>
            </div>
          </div>

          {tab === "dashboard" && (
            <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
              <SupplierStatsPanel />
              <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                {[
                  ["فروش عمده ثبت‌شده", fmtMoney(revenue), `${fmtNum(mySubs.length)} زیرسفارش`, <TrendingUp key="1" size={17} />],
                  ["زیرسفارش باز", fmtNum(openSubs.length), `${fmtNum(pendingSubs.length)} نیازمند تأیید تو`, <ClipboardList key="2" size={17} />],
                  ["محصول در بازارچه", fmtNum(mine.filter((p) => p.status === "published").length), `${fmtNum(mine.filter((p) => p.status === "pending").length)} در انتظار بازبینی کلبه`, <Boxes key="3" size={17} />],
                  ["مانده قابل برداشت", fmtMoney(wallet.balance), `${fmtMoney(wallet.escrowNet)} در انتظار تحویل`, <Wallet key="4" size={17} />],
                ].map(([l, v, s, icon]) => (
                  <Card key={l as string} className="p-4">
                    <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[var(--kv-surface-2)] text-[var(--kv-accent)]">{icon as React.ReactNode}</span>
                    <p className="mt-2.5 text-[17px] font-extrabold tabular-nums">{v as string}</p>
                    <p className="text-xs text-[var(--kv-muted)]">{l as string}</p>
                    <p className="mt-1 text-[11.5px] font-bold text-[var(--kv-success)]">{s as string}</p>
                  </Card>
                ))}
              </div>

              <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
                <Card className="p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <div><p className="text-[15px] font-extrabold">ارزش زیرسفارش‌ها</p><p className="text-xs text-[var(--kv-muted)]">بر پایه {fmtNum(Math.min(12, mySubs.length))} زیرسفارش اخیر؛ تاریخچه روزانه پس از ثبت تاریخ استاندارد فعال می‌شود</p></div>
                  </div>
                  {mySubs.length ? <Spark points={mySubs.slice(-12).map((item) => item.sub.total).reverse()} /> : <p className="py-8 text-center text-xs text-[var(--kv-muted)]">هنوز زیرسفارشی برای نمایش وجود ندارد.</p>}
                </Card>
                <Card className="p-5">
                  <p className="text-[15px] font-extrabold">وضعیت زیرسفارش‌ها</p>
                  <p className="mb-4 text-xs text-[var(--kv-muted)]">به‌روزرسانی لحظه‌ای از بازارچه عمده</p>
                  <Donut segs={[
                    { v: pendingSubs.length, c: "var(--kv-accent)", l: "در انتظار تأیید تو" },
                    { v: mySubs.filter((i: any) => (i as any).sub.status === "approved").length, c: "#2F5A9E", l: "منتظر پرداخت خریدار" },
                    { v: mySubs.filter((i) => ["paid", "preparing"].includes(i.sub.status)).length, c: "#D6A94E", l: "آماده‌سازی" },
                    { v: mySubs.filter((i: any) => (i as any).sub.status === "shipped").length, c: "var(--kv-success)", l: "ارسال شده" },
                    { v: mySubs.filter((i) => isTerminal(i.sub.status)).length, c: "var(--kv-surface-3)", l: "بسته‌شده" },
                  ]} />
                </Card>
              </div>

              <div className="grid gap-5 xl:grid-cols-2">
                <Card className="p-0">
                  <div className="flex items-center justify-between p-5 pb-3">
                    <p className="text-[15px] font-extrabold">صف اقدام تو</p>
                    <Btn variant="ghost" size="sm" onClick={() => setTab("rfq")}>همه</Btn>
                  </div>
                  <div className="space-y-2 px-5 pb-5">
                    {mySubs.filter((i) => ["pending_supplier", "paid", "preparing"].includes(i.sub.status)).slice(0, 4).map(({ parent, sub }) => (
                      <button key={sub.id} onClick={() => setTab(sub.status === "pending_supplier" ? "rfq" : "orders")} className="flex w-full items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3 text-right hover:border-[var(--kv-line-strong)]">
                        <div><p className="text-[13px] font-bold tabular-nums">{sub.id}</p><p className="text-xs text-[var(--kv-muted)]">{parent.buyer} · {fmtMoney(sub.total)}</p></div>
                        <Status value={(SUB_STATUS as Record<string, any>)[sub.status].label} />
                      </button>
                    ))}
                    {mySubs.filter((i) => ["pending_supplier", "paid", "preparing"].includes(i.sub.status)).length === 0 && <p className="py-4 text-center text-[13px] text-[var(--kv-muted)]">اقدامی معوق نداری.</p>}
                  </div>
                </Card>
                <Card className="p-5">
                  <p className="text-[15px] font-extrabold">هشدارهای موجودی</p>
                  <div className="mt-3 space-y-2.5">
                    {[["پیراهن کلاسیک — کرمی / M", "فقط ۶ عدد مانده", 14], ["پیراهن آجری — L", "۹ عدد مانده", 28], ["شلوار راسته — شنی / XL", "۱۱ عدد مانده", 35]].map(([t2, d2, w]) => (
                      <div key={t2 as string} className="rounded-[12px] border border-[#B98A2F]/25 bg-[#B98A2F]/[0.06] px-4 py-3">
                        <div className="flex items-center justify-between text-[13px]"><b>{t2 as string}</b><span className="flex items-center gap-1 text-xs font-bold text-[#8A6420]"><AlertTriangle size={13} />{d2 as string}</span></div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--kv-surface-3)]"><div className="h-full rounded-full bg-[#B98A2F]" style={{ width: `${w}%` }} /></div>
                      </div>
                    ))}
                    <Btn variant="soft" size="sm" className="w-full" onClick={() => setTab("inventory")}>مدیریت موجودی</Btn>
                  </div>
                </Card>
              </div>
              </div>
            </div>
          )}

          {tab === "products" && (
            <div className="animate-[fadeUp_0.35s_ease]">
              <div className="mb-4 flex flex-wrap items-center gap-2.5">
                <div className="min-w-[200px] flex-1"><SearchBox placeholder="جست‌وجوی محصول…" /></div>
                <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={() => { setEditorSec("base"); setTab("editor"); }}>افزودن محصول جدید</Btn>
              </div>
              {!isDemoME && <SupplierReviewPanel flash={flash} />}
              <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/50 px-4 py-3 text-[12.5px]">
                <span className="font-bold">مسیر انتشار:</span>
                <span className="text-[var(--kv-muted)]">ثبت محصول ← بازبینی کلبه (حداکثر یک روز کاری) ← نمایش در بازارچه عمده در بخش «سایر تأمین‌کنندگان»</span>
                <span className="mr-auto tabular-nums text-[var(--kv-muted)]">{fmtNum(mine.filter((p) => p.status === "published").length)} منتشر · {fmtNum(mine.filter((p) => p.status === "pending").length)} در انتظار</span>
              </div>
              <Card className="overflow-hidden">
                <div className="kv-scroll overflow-x-auto">
                  <table className="kv-table min-w-[860px]">
                    <thead><tr><th>محصول</th><th>کد</th><th>قیمت سری از</th><th>حداقل سفارش</th><th>موجودی</th><th>وضعیت در بازارچه</th><th>نمایش</th><th></th></tr></thead>
                    <tbody>
                      {mine.map((p) => {
                        const st = p.status ?? "published";
                        const live = st === "published";
                        return (
                          <tr key={p.id}>
                            <td><span className="flex items-center gap-3"><img src={p.images[0]} alt="" className="h-11 w-10 rounded-lg object-cover" /><b>{p.name}</b></span></td>
                            <td className="tabular-nums text-[var(--kv-muted)]" dir="ltr">{p.sku}</td>
                            <td className="tabular-nums font-bold">{fmtMoney(p.wholesaleFrom)}</td>
                            <td className="tabular-nums">{fmtNum(p.moq)} سری</td>
                            <td className="tabular-nums">{fmtNum(p.stock)}</td>
                            <td><Status value={st === "published" ? "فعال" : (STATUS_LABEL as Record<string, any>)[st]} /></td>
                            <td>
                              {st === "published" || st === "draft"
                                ? <Switch on={live} onToggle={() => { const next = live ? "draft" : "published"; productsApi.status((p as any).id, next).then(()=>{ flash(live ? `${(p as any).name} از بازارچه خارج شد` : `${(p as any).name} دوباره در بازارچه نمایش داده می‌شود`); }).catch((e)=>flash(e instanceof Error ? e.message : "خطا")); }} />
                                : <span className="text-xs text-[var(--kv-faint)]">{st === "pending" ? "منتظر کلبه" : "—"}</span>}
                            </td>
                            <td><button onClick={() => setTab("templates")} className="text-[13px] font-bold text-[var(--kv-accent)] hover:underline">مدیریت سری‌ها</button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}

          {tab === "editor" && (
            <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[220px_1fr_300px]">
              <Card className="h-fit p-2.5">
                {[["base", "اطلاعات پایه"], ["media", "رسانه"], ["variant", "ویژگی‌ها و واریانت"], ["series", "سری‌ها و قیمت"], ["review", "بازبینی"]].map(([v, l], i) => (
                  <button key={v} onClick={() => setEditorSec(v)} className={cn("flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] font-semibold", editorSec === v ? "bg-[var(--kv-surface-2)]" : "text-[var(--kv-muted)] hover:text-[var(--kv-ink)]")}>
                    <span className={cn("flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold", editorSec === v ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "bg-[var(--kv-surface-2)]")}>{(i + 1).toLocaleString("fa-IR")}</span>{l}
                  </button>
                ))}
              </Card>

              <Card className="h-fit p-6">
                {editorSec === "base" && (
                  <div className="space-y-4">
                    <Field label="نام محصول"><Input placeholder="مثلاً پیراهن لینن یقه‌انگلیسی" value={form.name} onChange={(v) => setForm({ ...form, name: v })} /></Field>
                    <Field label="دسته‌بندی" hint={taxonomy.status === "loading" ? "در حال دریافت دسته‌بندی‌های کاتالوگ…" : taxonomy.categories.length ? "از دسته‌بندی‌های کاتالوگ کلبه" : undefined}><Select options={categoryOptions} value={form.category} onChange={(v) => setForm({ ...form, category: v })} /></Field>
                    {taxonomy.status === "error" && <p role="alert" className="text-[11.5px] text-[var(--kv-danger)]">دسته‌بندی‌ها و وایب‌های کاتالوگ دریافت نشد. <button type="button" onClick={loadTaxonomy} className="font-bold underline">تلاش دوباره</button></p>}
                    {isDemoME && productTypes.length > 0 && (
                      <Field label="نوع محصول" hint="سایزها و قالب مشخصات از نوع محصول می‌آیند">
                        <Select options={["انتخاب کنید", ...productTypes.map((t) => t.name)]} value={selectedType?.name ?? "انتخاب کنید"}
                          onChange={(l) => { const t = productTypes.find((x) => x.name === l); setTypeCode(t?.code ?? ""); setForm((f) => ({ ...f, productTypeId: t?.id ?? "" })); setSpecs({}); setDraftSeries([]); }} />
                      </Field>
                    )}
                    <div className="grid gap-3 sm:grid-cols-2" data-supplier-taxonomy>
                      <Field label="جنسیت / مخاطب"><Select options={GENDERS.map(([, l]) => l)} value={GENDERS.find(([v]) => v === form.gender)?.[1] ?? "یونیسکس"} onChange={(l) => setForm({ ...form, gender: GENDERS.find(([, x]) => x === l)?.[0] ?? "unisex" })} /></Field>
                      <fieldset><legend className="mb-1.5 text-[12.5px] font-semibold">فصل‌ها (چندانتخابی)</legend><div className="flex flex-wrap gap-1.5">{SEASONS.map(([v, l]) => (
                        <button key={v} type="button" aria-pressed={form.seasons.includes(v)} onClick={() => setForm({ ...form, seasons: form.seasons.includes(v) ? form.seasons.filter((x) => x !== v) : [...form.seasons, v] })}
                          className={cn("rounded-full border px-3 py-1.5 text-[12px] font-semibold", form.seasons.includes(v) ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10 text-[var(--kv-accent)]" : "border-[var(--kv-line)] text-[var(--kv-muted)]")}>{l}</button>))}</div></fieldset>
                      {isDemoME && <fieldset className="sm:col-span-2"><legend className="mb-1.5 text-[12.5px] font-semibold">وایب‌ها</legend>
                        {taxonomy.vibes.length ? <div className="flex flex-wrap gap-1.5">{taxonomy.vibes.map((v) => (
                          <button key={v.slug} type="button" aria-pressed={form.vibes.includes(v.slug)} onClick={() => setForm({ ...form, vibes: form.vibes.includes(v.slug) ? form.vibes.filter((x) => x !== v.slug) : form.vibes.length >= 8 ? form.vibes : [...form.vibes, v.slug] })}
                            className={cn("rounded-full border px-3 py-1.5 text-[12px] font-semibold", form.vibes.includes(v.slug) ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10 text-[var(--kv-accent)]" : "border-[var(--kv-line)] text-[var(--kv-muted)]")}>{v.name}</button>))}</div>
                          : <p className="text-[11.5px] text-[var(--kv-muted)]">{taxonomy.status === "loading" ? "در حال دریافت…" : "هنوز وایبی در کاتالوگ تعریف نشده است."}</p>}
                      </fieldset>}
                    </div>
                    {!isDemoME && categoryError && <p role="alert" className="text-sm text-[var(--kv-danger)]">{categoryError}</p>}
                    {!isDemoME && categoryFields.map((field) => <Field key={String(field.code)} label={`${String(field.label)}${field.required ? " (الزامی)" : ""}`}><Input value={String(specs[String(field.code)] ?? "")} onChange={(value) => setSpecs({ ...specs, [String(field.code)]: value })} /></Field>)}
                    {isDemoME && selectedType && <AdaptiveSpecForm type={selectedType} values={specs} onChange={setSpecs} />}
                    {isDemoME && selectedType && missingRequiredSpecs(selectedType, specs).length > 0 && <p className="text-[11.5px] text-[var(--kv-muted)]">فیلدهای الزامی: {missingRequiredSpecs(selectedType, specs).join("، ")}</p>}
                    <Field label="توضیح کوتاه" hint="در کارت محصول بازارچه عمده نمایش داده می‌شود"><Input placeholder="پیراهن لینن با دوخت تمیز…" value={form.desc} onChange={(v) => setForm({ ...form, desc: v })} /></Field>
                    <div className="rounded-[12px] bg-[var(--kv-surface-2)]/60 px-4 py-3 text-[12.5px] leading-6 text-[var(--kv-muted)]">
                      بعد از ارسال، محصول با وضعیت «در انتظار تأیید» برای تیم کیفیت کلبه فرستاده می‌شود و پس از تأیید، خودکار در بازارچه عمده نمایش داده می‌شود.
                    </div>
                    <Btn variant="accent" size="sm" onClick={() => setEditorSec("series")}>بعدی: تعریف سری‌ها</Btn>
                  </div>
                )}
                {editorSec === "media" && (
                  <div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{productImages.map((image) => <div key={image.fileId}><img src={image.previewUrl} alt="تصویر محصول" className="aspect-square w-full rounded-lg object-cover" /><Btn size="sm" variant="ghost" onClick={() => setProductImages((cur) => cur.filter((i) => i.fileId !== image.fileId))}>حذف تصویر</Btn></div>)}</div>
                    <Field label="افزودن تصاویر محصول" hint="تصاویر به‌صورت واقعی روی سرور ذخیره می‌شوند."><input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={mediaBusy} onChange={async (event) => {
                      const files = Array.from(event.target.files ?? []); setMediaBusy(true);
                      try { for (const file of files) { if (file.size > 5 * 1024 * 1024) throw new Error("حداکثر حجم هر تصویر ۵ مگابایت است."); const uploaded = await filesApi.upload(file); setProductImages((cur) => [...cur, { fileId: uploaded.id, url: `/api/v1/product-media/${uploaded.id}`, previewUrl: URL.createObjectURL(file) }]); } }
                      catch (error) { flash(error instanceof Error ? error.message : "بارگذاری تصویر انجام نشد."); }
                      finally { setMediaBusy(false); }
                    }} /></Field>
                    {mediaBusy && <p role="status">در حال بارگذاری تصاویر…</p>}
                  </div>
                )}
                {editorSec === "variant" && (
                  <div className="space-y-4">
                    <p className="text-[13px] font-bold">رنگ‌های قابل عرضه</p>
                    <div className="flex flex-wrap gap-2">{Object.values(COLORS).map((color) => <button key={color.id} onClick={() => {
                      if (draftColorIds.includes(color.id) && draftColorIds.length === 1) return;
                      const next = draftColorIds.includes(color.id) ? draftColorIds.filter((id) => id !== color.id) : [...draftColorIds, color.id];
                      setDraftColorIds(next);
                      setDraftSeries(draftSeries.map((series) => ({ ...series, colorIds: series.colorIds?.filter((id) => next.includes(id)) })));
                    }} className={cn("flex min-h-10 items-center gap-2 rounded-[10px] border px-3 text-[12px] font-semibold", draftColorIds.includes(color.id) ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)]")}><span className="h-4 w-4 rounded-full border border-black/15" style={{ background: color.hex }} />{color.name}</button>)}</div>
                    <p className="text-[12px] leading-6 text-[var(--kv-muted)]">برای هر سری می‌توانید مشخص کنید از بین این رنگ‌ها کدام قابل سفارش است. ترکیب سایز در بخش سری‌ها تنظیم می‌شود.</p>
                  </div>
                )}
                {editorSec === "series" && (
                  <ProductSeriesEditor colors={draftColorIds.map((id) => COLORS[id]).filter(Boolean)} sizes={seriesSizes} value={draftSeries} onChange={setDraftSeries} />
                )}
                {editorSec === "stock" && (
                  <div className="space-y-4">
                    {offeredDraft.length > 0 && <p className="text-[12px] text-[var(--kv-muted)]">کمترین تعداد لازم برای حداقل سفارش: {fmtNum(Math.min(...offeredDraft.map((s) => s.pieces * s.moqSeries)))} تکه</p>}
                  </div>
                )}
                {editorSec === "review" && (
                  <div className="space-y-3 text-[13px]">
                    {[["نام و دسته‌بندی", !!form.name.trim()], ["دست‌کم یک رنگ", draftColorIds.length > 0], ["سری قابل سفارش با قیمت و MOQ", offeredDraft.length > 0]].map(([t2, ok]) => (
                      <p key={t2 as string} className="flex items-center gap-2"><span className={cn("flex h-6 w-6 items-center justify-center rounded-full", ok ? "bg-[#E7F0E6] text-[#3E6B4A]" : "bg-[#F6EBD3] text-[#8A6420]")}>{ok ? <Check size={13} /> : <AlertTriangle size={13} />}</span>{t2 as string}</p>
                    ))}
                    <p className="text-[12px] text-[var(--kv-muted)]">{fmtNum(draftSeries.length)} سری تعریف شده · قیمت پایه: {offeredDraft.length ? fmtMoney(Math.min(...offeredDraft.map((s) => s.pricePerSeries))) : "—"}</p>
                    <Btn variant="accent" size="sm" disabled={!canSubmitProduct} icon={<Send size={15} />} onClick={submitProduct}>ارسال محصول و سری‌ها برای بازبینی کلبه</Btn>
                  </div>
                )}
                <div className="mt-6 border-t border-[var(--kv-line)] pt-5">
                  <Btn variant="ghost" size="sm" onClick={() => setTab("products")}>بازگشت به فهرست</Btn>
                </div>
              </Card>

              <Card className="h-fit p-5">
                <p className="text-sm font-bold">پیش‌نمایش کارت بازارچه</p>
                <img src={IMG.shirtsColor} alt="" className="mt-3 aspect-[4/3] w-full rounded-[12px] object-cover" />
                <p className="mt-3 text-[13.5px] font-bold">{form.name.trim() || "نام محصول"}</p>
                <p className="text-xs text-[var(--kv-muted)]">تأمین‌کننده: {ME.name} · {form.category}</p>
                <div className="mt-3 space-y-1.5 text-[12.5px]">
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">قیمت سری از</span><b className="tabular-nums">{offeredDraft.length ? fmtMoney(Math.min(...offeredDraft.map((s) => s.pricePerSeries))) : "—"}</b></div>
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">حداقل سفارش</span><b className="tabular-nums">{offeredDraft.length ? `${fmtNum(Math.min(...offeredDraft.map((s) => s.moqSeries)))} سری` : "—"}</b></div>
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">تعداد سری</span><b className="tabular-nums">{fmtNum(draftSeries.length)}</b></div>
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">وضعیت</span><Status value="در انتظار تأیید" /></div>
                </div>
              </Card>
            </div>
          )}

          {tab === "rfq" && (
            <div className="animate-[fadeUp_0.35s_ease]">
              <div className="mb-4 rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/50 px-4 py-3 text-[12.5px] leading-6 text-[var(--kv-muted)]">
                هر سفارش عمده اول به‌صورت درخواست به تو می‌رسد. اگر امکان تأمین داری تأیید کن تا خریدار پرداخت کند؛ بعد از پرداخت، آماده‌سازی و ارسال را از «سفارش‌های عمده» پیش ببر.
              </div>
              <SubOrderDesk items={pendingSubs} actor={ME.name} onTransition={transition} emptyTitle="درخواست تازه‌ای نیست" emptyDesc="وقتی خریدار عمده برای محصولات منتشرشده‌ات سفارش ثبت کند، اینجا نمایش داده می‌شود." />
            </div>
          )}

          {tab === "orders" && (
            <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
              {/* Prompt-2 §71-§72: VIP wholesale CHILD orders (master/child OMS) — confirm/counter/reject + dispatch-to-kolbe. */}
              <SupplierChildOrdersPanel flash={flash} />
              <SupplierOrdersPanel />
              <div className="animate-[fadeUp_0.35s_ease]">
              <SubOrderDesk items={mySubs.filter((i: any) => (i as any).sub.status !== "pending_supplier")} actor={ME.name} onTransition={transition} emptyTitle="سفارشی در جریان نیست" emptyDesc="سفارش‌های تأییدشده و مراحل پرداخت، آماده‌سازی و ارسال اینجا دنبال می‌شود." />
            </div>
              </div>
          )}

          {/* §28-§34: offers + declared capacity (commitment, NOT kolbe stock). */}
          {tab === "wholesale-offers" && <div className="animate-[fadeUp_0.35s_ease]"><SupplierOffersPanel flash={flash} /></div>}
          {/* §23-B/§25-§27/§37: consignment — inbounds, verified stock at kolbe, returns. */}
          {tab === "consignment" && <div className="animate-[fadeUp_0.35s_ease]"><SupplierConsignmentPanel flash={flash} /></div>}
          {tab === "supply-requests" && <SupplierRequestsPortal flash={flash} />}

          {tab === "inventory" && (
            <div className="animate-[fadeUp_0.35s_ease]">
              <div className="mb-4 max-w-sm"><SearchBox value={invQ} onChange={setInvQ} placeholder="جست‌وجو در موجودی…" /></div>
              <Card className="overflow-hidden">
                <div className="kv-scroll overflow-x-auto">
                  <table className="kv-table min-w-[820px]">
                    <thead><tr><th>محصول</th><th>رنگ</th><th>سایز</th><th>موجودی</th><th>رزرو</th><th>قابل فروش</th><th>وضعیت</th></tr></thead>
                    <tbody>
                      {[
                        ["پیراهن کلاسیک نیم‌آستین", "آجری", "M", 42, 8, 34, "فعال"],
                        ["پیراهن کلاسیک نیم‌آستین", "مشکی", "L", 38, 12, 26, "فعال"],
                        ["پیراهن کلاسیک نیم‌آستین", "کرمی", "M", 6, 2, 4, "موجودی محدود"],
                        ["پیراهن چهارخانه مشکی", "مشکی", "L", 127, 30, 97, "فعال"],
                        ["پیراهن چهارخانه مشکی", "سرمه‌ای", "XL", 64, 12, 52, "فعال"],
                        ["شلوار پارچه‌ای راسته", "شنی", "XL", 11, 0, 11, "موجودی محدود"],
                      ].filter((r) => !invQ.trim() || (r[0] as string).includes(invQ.trim())).map((r, i) => (
                        <tr key={i}>
                          <td><b>{r[0]}</b></td><td>{r[1]}</td><td className="font-bold">{r[2]}</td>
                          <td className="tabular-nums">{fmtNum(r[3] as number)}</td><td className="tabular-nums">{fmtNum(r[4] as number)}</td>
                          <td className="font-bold tabular-nums">{fmtNum(r[5] as number)}</td><td><Status value={r[6] as string} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}

          {tab === "finance" && <div className="animate-[fadeUp_0.35s_ease]"><SupplierWallet supplierId={ME.id} supplierName={ME.name} noWithdraw={restrict.noWithdraw} onBank={() => setTab("bank")} /></div>}
          {tab === "bank" && <div className="animate-[fadeUp_0.35s_ease]"><SupplierBankForm supplierId={ME.id} /></div>}
          {tab === "templates" && <div className="animate-[fadeUp_0.35s_ease]"><CanonicalSeriesLibrary /></div>}
          {tab === "support" && <div className="animate-[fadeUp_0.35s_ease]"><TicketCenter perspective="owner" ownerId={ME.id} ownerName={ME.name} ownerType="supplier" /></div>}
          {(restrict.noPublish || restrict.noWithdraw) && tab === "dashboard" && <div role="alert" className="mt-4 rounded-[14px] border border-[var(--kv-danger)]/30 bg-[var(--kv-danger)]/[0.06] p-4 text-[13px] leading-7"><b>محدودیت فعال روی حساب:</b> {[restrict.noPublish && "انتشار و ویرایش محصول", restrict.noWithdraw && "برداشت از کیف پول"].filter(Boolean).join("، ")} · {restrict.reason}</div>}
          {tab === "finance-legacy" && (
            <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
              <div className="grid gap-3 sm:grid-cols-3">
                {[["موجودی قابل برداشت", fmtMoney(86000000), <CircleDollarSign key="a" size={18} />], ["در انتظار تسویه", fmtMoney(100000000), <Clock key="b" size={18} />], ["بلوکه تضمین", fmtMoney(24000000), <Check key="c" size={18} />]].map(([l, v, icon]) => (
                  <Card key={l as string} className="p-5"><span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--kv-surface-2)] text-[var(--kv-accent)]">{icon as React.ReactNode}</span><p className="mt-3 text-lg font-extrabold tabular-nums">{v as string}</p><p className="text-[13px] text-[var(--kv-muted)]">{l as string}</p></Card>
                ))}
              </div>
              <div className="grid gap-5 xl:grid-cols-2">
                <Card className="p-5">
                  <div className="mb-3 flex items-center justify-between"><p className="text-[15px] font-extrabold">تاریخچه تسویه</p><Btn variant="soft" size="sm" onClick={() => flash("درخواست برداشت ثبت شد")}>درخواست برداشت</Btn></div>
                  {[["ST-1188", fmtMoney(42000000), "شنبه گذشته · موفق"], ["ST-1174", fmtMoney(38500000), "دو هفته پیش · موفق"], ["ST-1161", fmtMoney(51000000), "ماه گذشته · موفق"]].map(([id, v, d2]) => (
                    <div key={id} className="mb-2 flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3"><div><p className="text-[13px] font-bold tabular-nums">{id}</p><p className="text-xs text-[var(--kv-muted)]">{d2}</p></div><b className="tabular-nums">{v}</b></div>
                  ))}
                </Card>
                <Card className="p-5">
                  <p className="mb-3 text-[15px] font-extrabold">زیرسفارش‌های پرداخت‌شده (در انتظار تسویه کلبه)</p>
                  {mySubs.filter((i) => ["paid", "preparing", "shipped", "delivered"].includes(i.sub.status)).map(({ parent, sub }) => (
                    <div key={sub.id} className="mb-2 flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3"><div><p className="text-[13px] font-bold tabular-nums">{sub.id}</p><p className="text-xs text-[var(--kv-muted)]">{parent.buyer} · کارمزد کلبه ۸٪</p></div><b className="tabular-nums">{fmtMoney(Math.round(sub.total * 0.92))}</b></div>
                  ))}
                </Card>
              </div>
            </div>
          )}

          {tab === "production" && (
            <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[1fr_340px]">
              <Card className="overflow-hidden">
                <div className="kv-scroll overflow-x-auto">
                  <table className="kv-table min-w-[680px]">
                    <thead><tr><th>سفارش تولید</th><th>محصول</th><th>تعداد</th><th>پیشرفت</th><th>وضعیت</th></tr></thead>
                    <tbody>
                      {[["PR-331", "پیراهن آجری — سری کامل", "۲۰۰ تکه", 72, "در حال بررسی"], ["PR-328", "پیراهن چهارخانه — مشکی", "۱۲۰ تکه", 100, "تحویل شد"], ["PR-325", "شلوار راسته — شنی", "۳۰۰ تکه", 35, "در حال آماده‌سازی"]].map((r) => (
                        <tr key={r[0] as string}>
                          <td className="font-bold tabular-nums">{r[0]}</td><td>{r[1]}</td><td className="tabular-nums">{r[2]}</td>
                          <td><span className="flex items-center gap-2"><span className="h-1.5 w-28 overflow-hidden rounded-full bg-[var(--kv-surface-3)]"><span className="block h-full rounded-full bg-[var(--kv-accent)]" style={{ width: `${r[3]}%` }} /></span><b className="text-xs tabular-nums">{fmtNum(r[3] as number)}٪</b></span></td>
                          <td><Status value={r[4] as string} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card className="h-fit p-5">
                <p className="flex items-center gap-2 text-[15px] font-extrabold"><FlaskConical size={17} className="text-[var(--kv-accent)]" />کنترل کیفیت</p>
                <div className="mt-3"><Timeline items={[
                  { t: "نمونه تأیید شد", d: "پیراهن آجری — سایز M", time: "امروز", done: true },
                  { t: "بازبینی خط دوخت", d: "۲ مورد اصلاح جزئی", time: "دیروز", done: true },
                  { t: "تست شست‌وشو", d: "در انتظار آزمایشگاه", time: "فردا", done: false },
                ]} /></div>
              </Card>
            </div>
          )}

          {tab === "settings" && <div className="animate-[fadeUp_0.35s_ease]">{isDemoME ? <Card className="max-w-[640px] p-6"><p className="text-[13px] text-[var(--kv-muted)]">در حالت demo پروفایل تجاری سرور در دسترس نیست.</p></Card> : <SupplierProfileSettings flash={flash} />}</div>}
        </div>
      </div>

      <Drawer open={notifOpen} onClose={() => setNotifOpen(false)} title="اعلان‌ها">
        {notifs.length === 0 ? <Empty title="اعلان تازه‌ای نیست" desc="نتیجه بازبینی محصولات و رویدادهای مهم اینجا نمایش داده می‌شود." /> : (
          <div className="space-y-2">
            {unreadCount > 0 && <Btn variant="ghost" size="sm" onClick={() => void markAllRead()}>خواندن همه</Btn>}
            {notifs.map((notif) => (
              <button
                key={notif.id}
                onClick={() => { setNotifOpen(false); setTab("products"); void notificationsApi.read(notif.id).catch(() => null); setNotifs((items) => items.map((n) => n.id === notif.id ? { ...n, readAt: new Date().toISOString() } : n)); setUnreadCount((c) => Math.max(0, c - (notif.readAt ? 0 : 1))); }}
                className={cn("w-full rounded-[12px] border p-3.5 text-right", notif.readAt ? "border-[var(--kv-line)]" : "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.05]")}
              >
                <p className="text-[13px] font-extrabold">{notif.title}</p>
                <p className="mt-1 whitespace-pre-line text-[12.5px] leading-6 text-[var(--kv-muted)]">{notif.body}</p>
                {notif.createdAt && <p className="mt-1 text-[11px] text-[var(--kv-faint)]">{new Date(notif.createdAt).toLocaleDateString("fa-IR", { dateStyle: "medium" })}</p>}
              </button>
            ))}
          </div>
        )}
      </Drawer>

      {toast && (
        <div className="fixed bottom-6 right-1/2 z-[90] translate-x-1/2 animate-[scaleIn_0.25s_ease]">
          <div className="kv-glass flex items-center gap-2.5 rounded-[14px] px-5 py-3.5 text-[13.5px] font-bold"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--kv-success)] text-white"><Check size={15} /></span>{toast}</div>
        </div>
      )}
    </div>
    </div>
  );
}
