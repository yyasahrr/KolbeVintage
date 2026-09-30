import { useCallback, useEffect, useState } from "react";
import { Boxes, MapPin, PackageCheck, RefreshCw, Truck, Upload } from "lucide-react";
import { fmtNum } from "../data/catalog";
import { formatPersianDateTime, todayIso } from "../data/persian-date";
import { trackingApi } from "../data/api";
import { Btn, Card, Drawer, Empty, ErrorState, Field, Input, LoadingState, Segmented, Select, Status, Textarea } from "./primitives";

const stamp = (value: unknown) => (value ? formatPersianDateTime(String(value)) : "—");
const text = (value: unknown, fallback = "—") => (value === null || value === undefined || value === "" ? fallback : String(value));
const num = (value: unknown) => fmtNum(Number(value ?? 0));
const rial = (value: unknown) => `${fmtNum(Number(String(value ?? "0")))} ریال`;

const SOURCES = ["manual", "n8n", "carrier_api", "carrier_website", "email", "excel", "csv", "pdf", "upload", "webhook"];

type Tab = "shipments" | "imports";
const TABS: { v: Tab; label: string }[] = [
  { v: "shipments", label: "مرسوله‌ها و کدهای رهگیری" },
  { v: "imports", label: "ورود خودکار و صف بازبینی" },
];

/** Tracking automation center (items 90-94): every shipment with its carrier,
 *  customer and status, the n8n import pipeline and the manual review queue. */
export function TrackingCenter({ flash }: { flash: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>("shipments");
  const [shipments, setShipments] = useState<Record<string, unknown>[]>([]);
  const [stats, setStats] = useState<Record<string, string>>({});
  const [imports, setImports] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ shipment: Record<string, unknown>; timeline: Record<string, unknown>[] } | null>(null);
  const [reviewItems, setReviewItems] = useState<Record<string, unknown>[]>([]);
  const [search, setSearch] = useState("");
  const [needsReview, setNeedsReview] = useState<"false" | "true">("false");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [event, setEvent] = useState({ status: "", location: "", occurredAt: todayIso(), source: "manual", note: "" });
  const [importDraft, setImportDraft] = useState({ open: false, source: "n8n", orderReference: "", trackingCode: "", carrier: "پست", status: "in_transit", location: "تهران" });

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [list, imps] = await Promise.all([
        trackingApi.shipments({ ...(search ? { search } : {}), needsReview, limit: 100 }),
        trackingApi.imports(),
      ]);
      setShipments(list.items); setStats(list.stats); setImports(imps.items);
      const imported = imps.items[0];
      if (imported) {
        const items = await trackingApi.importItems(String(imported.id));
        setReviewItems(items.items);
      } else setReviewItems([]);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری رهگیری"); }
    finally { setLoading(false); }
  }, [search, needsReview]);
  useEffect(() => { void load(); }, [load]);

  const openShipment = async (id: string) => {
    setSelected(id);
    try { setDetail(await trackingApi.shipment(id)); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در دریافت مرسوله"); }
  };

  const run = async (label: string, action: () => Promise<unknown>) => {
    try { await action(); flash(`${label} انجام شد`); await load(); if (selected) await openShipment(selected); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در اجرای عملیات"); }
  };

  if (loading && !shipments.length) return <LoadingState label="در حال بارگذاری مرکز رهگیری…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <Card className="p-4"><Segmented options={TABS} value={tab} onChange={setTab} /></Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[["کل مرسوله", stats.total], ["تحویل‌شده", stats.delivered], ["در مسیر", stats.in_transit], ["نیازمند بازبینی (رویداد)", stats.needs_review], ["صف بازبینی ورودی", stats.review_queue]]
          .map(([label, value]) => (
            <Card key={label as string} className="p-4">
              <p className="text-[11.5px] text-[var(--kv-muted)]">{label as string}</p>
              <p className="mt-1 text-[20px] font-extrabold tabular-nums">{num(value)}</p>
            </Card>
          ))}
      </div>

      {tab === "shipments" && (
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input value={search} onChange={setSearch} placeholder="کد رهگیری، شماره سفارش یا همراه" className="w-64" />
            <Select options={["false", "true"]} value={needsReview} onChange={(v) => setNeedsReview(v as "false" | "true")} />
            <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>اعمال فیلتر</Btn>
            <span className="text-[11.5px] text-[var(--kv-muted)]">ستون آخر: «true» فقط مرسوله‌های دارای رویداد نیازمند بازبینی.</span>
          </div>
          <div className="kv-scroll overflow-x-auto">
            <table className="w-full min-w-[900px] text-right text-[12.5px]">
              <thead><tr className="text-[11.5px] text-[var(--kv-muted)]">
                <th className="pb-2">کد رهگیری</th><th className="pb-2">سفارش</th><th className="pb-2">مشتری</th><th className="pb-2">حامل</th>
                <th className="pb-2">وضعیت</th><th className="pb-2">آخرین موقعیت</th><th className="pb-2">آخرین به‌روزرسانی</th><th className="pb-2">بازبینی</th><th className="pb-2"></th>
              </tr></thead>
              <tbody className="divide-y divide-[var(--kv-line)]">
                {shipments.map((row) => (
                  <tr key={String(row.id)}>
                    <td className="py-2 font-semibold tabular-nums">{text(row.tracking_code, "—")}</td>
                    <td className="py-2 text-[11.5px]">{text(row.order_reference)}</td>
                    <td className="py-2 text-[11.5px]">{text(row.customer_name)}<span className="block text-[10.5px] text-[var(--kv-muted)]">{text(row.customer_phone)}</span></td>
                    <td className="py-2 text-[11.5px]">{text(row.carrier)}</td>
                    <td className="py-2"><Status value={text(row.status)} /></td>
                    <td className="py-2 text-[11.5px]">{text(row.last_location)}</td>
                    <td className="py-2 text-[11.5px]">{stamp(row.last_status_at ?? row.updated_at)}</td>
                    <td className="py-2">{Number(row.pending_review) > 0 ? <Status value="نیازمند بازبینی" /> : <Status value="تأییدشده" />}</td>
                    <td className="py-2"><Btn variant="soft" size="sm" onClick={() => void openShipment(String(row.id))}>جزئیات</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shipments.length && <Empty title="مرسوله‌ای یافت نشد" desc="مرسوله‌ها از سفارش‌های ارسال‌شده یا ورود خودکار ساخته می‌شوند." />}
          </div>
        </Card>
      )}

      {tab === "imports" && (
        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[13px] font-extrabold"><Upload size={16} />ورودها (n8n / حامل / فایل / ایمیل)</div>
              <Btn variant="soft" size="sm" onClick={() => setImportDraft({ ...importDraft, open: true })}>ورود دستی</Btn>
            </div>
            <div className="space-y-2">
              {imports.map((row) => (
                <div key={String(row.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-[11px] border border-[var(--kv-line)] p-3 text-[12px]">
                  <div>
                    <p className="font-bold">{text(row.source)} · {num(row.item_count)} آیتم</p>
                    <p className="text-[11.5px] text-[var(--kv-muted)]">{stamp(row.created_at)} · وضعیت {text(row.status)}</p>
                  </div>
                  {Number(row.needs_review ?? 0) > 0 ? <Status value="نیازمند بازبینی" /> : <Status value="تأییدشده" />}
                </div>
              ))}
              {!imports.length && <Empty title="ورودی ثبت نشده" desc="n8n می‌تواند از API رهگیری، PDF، اکسل، CSV یا ایمیل کد رهگیری را استخراج و به اینجا بفرستد." />}
            </div>
          </Card>
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><Boxes size={16} />صف بازبینی ({num(reviewItems.length)})</div>
            <div className="space-y-2">
              {reviewItems.map((item) => (
                <div key={String(item.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-[11px] border border-[var(--kv-line)] p-3 text-[12px]">
                  <div>
                    <p className="font-bold">{text(item.tracking_code)} · {text(item.carrier)} · {text(item.status)}</p>
                    <p className="text-[11.5px] text-[var(--kv-muted)]">
                      اعتماد {num((Number(item.confidence ?? 0) * 100).toFixed(0))}٪ · سفارش {text(item.matched_order_id, "بدون تطابق")} · وضعیت {text(item.status === "needs_review" ? "needs_review" : item.status)}
                    </p>
                  </div>
                  {item.status === "needs_review" ? (
                    <div className="flex gap-2">
                      <Btn variant="soft" size="sm" onClick={() => void run("تأیید آیتم", () => trackingApi.reviewItem(String(item.id), { decision: "confirm" }))}>تأیید</Btn>
                      <Btn variant="ghost" size="sm" onClick={() => void run("رد آیتم", () => trackingApi.reviewItem(String(item.id), { decision: "reject", note: "نامشخص" }))}>رد</Btn>
                    </div>
                  ) : <Status value={text(item.status)} />}
                </div>
              ))}
              {!reviewItems.length && <Empty title="صف خالی است" desc="آیتم‌های کم‌اعتماد یا بدون تطابق اینجا برای تأیید انسانی می‌آیند." />}
            </div>
          </Card>
        </div>
      )}

      <Drawer open={!!selected} onClose={() => { setSelected(null); setDetail(null); }} title="جزئیات مرسوله" wide>
        {!detail ? <LoadingState label="در حال بارگذاری…" /> : (
          <div className="space-y-4">
            <div className="rounded-[12px] bg-[var(--kv-surface-2)]/70 p-4 text-[12.5px]">
              <p className="font-extrabold">{text(detail.shipment.reference)} · {text(detail.shipment.carrier)} · {text(detail.shipment.tracking_code)}</p>
              <p className="mt-1 text-[var(--kv-muted)]">
                {text(detail.shipment.origin, "—")} → {text(detail.shipment.destination, "—")} · {text(detail.shipment.customer_name)}
              </p>
              <p className="mt-1 text-[var(--kv-muted)]">سفارش {text(detail.shipment.order_reference)} · {rial(detail.shipment.total_rial)}</p>
            </div>
            <div>
              <p className="mb-2 text-[13px] font-extrabold">خط زمانی رهگیری</p>
              <div className="space-y-2">
                {detail.timeline.map((row) => (
                  <div key={String(row.id)} className="flex items-start justify-between gap-3 border-b border-dashed border-[var(--kv-line)] pb-2 text-[12px]">
                    <span className="flex items-start gap-2">
                      <MapPin size={14} className="mt-0.5 text-[var(--kv-accent)]" />
                      <span>
                        <b>{text(row.status)}</b>{row.location ? ` — ${text(row.location)}` : ""}
                        <span className="block text-[11px] text-[var(--kv-muted)]">
                          منبع {text(row.source)} · اعتماد {num((Number(row.confidence ?? 1) * 100).toFixed(0))}٪
                          {row.raw_reference ? ` · مرجع ${text(row.raw_reference)}` : ""} · {text(row.review_status)}
                        </span>
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--kv-muted)]">{stamp(row.occurred_at)}</span>
                  </div>
                ))}
                {!detail.timeline.length && <p className="text-[12px] text-[var(--kv-muted)]">رویدادی ثبت نشده است.</p>}
              </div>
            </div>
            <div className="rounded-[12px] border border-[var(--kv-line)] p-4">
              <p className="mb-2 flex items-center gap-2 text-[13px] font-extrabold"><Truck size={15} />ثبت رویداد رهگیری</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="وضعیت"><Input value={event.status} onChange={(v) => setEvent({ ...event, status: v })} placeholder="in_transit / delivered…" /></Field>
                <Field label="موقعیت"><Input value={event.location} onChange={(v) => setEvent({ ...event, location: v })} /></Field>
                <Field label="زمان (YYYY-MM-DD)"><Input value={event.occurredAt} onChange={(v) => setEvent({ ...event, occurredAt: v })} /></Field>
                <Field label="منبع"><Select options={SOURCES} value={event.source} onChange={(v) => setEvent({ ...event, source: v })} /></Field>
              </div>
              <Field label="یادداشت"><Textarea rows={2} value={event.note} onChange={(v) => setEvent({ ...event, note: v })} /></Field>
              <Btn variant="accent" size="sm" className="mt-2" icon={<PackageCheck size={14} />}
                disabled={event.status.trim().length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(event.occurredAt)}
                onClick={() => void run("ثبت رویداد", async () => {
                  await trackingApi.addEvent(String(selected), {
                    status: event.status, location: event.location || null,
                    occurredAt: new Date(`${event.occurredAt}T09:00:00.000Z`).toISOString(),
                    source: event.source, confidence: 1, note: event.note || null,
                  });
                  setEvent({ status: "", location: "", occurredAt: todayIso(), source: "manual", note: "" });
                })}>ثبت رویداد</Btn>
              <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">
                رویدادهای تأییدشده به‌طور خودکار برای مشتری اعلان و پیامک می‌سازند؛ رویدادهای کم‌اعتماد در صف بازبینی می‌مانند.
              </p>
            </div>
          </div>
        )}
      </Drawer>

      <Drawer open={importDraft.open} onClose={() => setImportDraft({ ...importDraft, open: false })} title="ورود دستی رهگیری">
        <div className="space-y-3">
          <Field label="منبع"><Select options={SOURCES} value={importDraft.source} onChange={(v) => setImportDraft({ ...importDraft, source: v })} /></Field>
          <Field label="شماره سفارش"><Input value={importDraft.orderReference} onChange={(v) => setImportDraft({ ...importDraft, orderReference: v })} placeholder="KV-1001" /></Field>
          <Field label="کد رهگیری"><Input value={importDraft.trackingCode} onChange={(v) => setImportDraft({ ...importDraft, trackingCode: v })} /></Field>
          <Field label="حامل"><Input value={importDraft.carrier} onChange={(v) => setImportDraft({ ...importDraft, carrier: v })} /></Field>
          <Field label="وضعیت"><Input value={importDraft.status} onChange={(v) => setImportDraft({ ...importDraft, status: v })} /></Field>
          <Btn variant="accent" className="w-full"
            disabled={!importDraft.orderReference && !importDraft.trackingCode}
            onClick={() => void run("ورود رهگیری", async () => {
              await trackingApi.import({
                source: importDraft.source,
                items: [{
                  orderReference: importDraft.orderReference || null, trackingCode: importDraft.trackingCode || null,
                  carrier: importDraft.carrier || null, status: importDraft.status || null,
                  location: importDraft.location || null, occurredAt: new Date().toISOString(), confidence: 1,
                }],
              });
              setImportDraft({ ...importDraft, open: false, orderReference: "", trackingCode: "" });
            })}>ثبت ورود</Btn>
        </div>
      </Drawer>
    </div>
  );
}
