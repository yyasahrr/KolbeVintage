import { useEffect, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { fmtMoney, fmtNum, type Colorway, type SeriesDef } from "../data/catalog";
import { Btn, Field, Input, Switch } from "../components/primitives";
import { cn } from "../utils/cn";

const SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"];

function blankSeries(colors: Colorway[]): SeriesDef {
  return {
    id: `series-${Date.now()}`,
    name: "",
    pieces: 0,
    composition: { S: 0, M: 0, L: 0, XL: 0, "2XL": 0, "3XL": 0 },
    moqSeries: 1,
    pricePerSeries: 0,
    available: true,
    colorIds: colors.map((color) => color.id),
  };
}

export function SeriesBuilder({ value, onChange, colors }: {
  value: SeriesDef[];
  onChange: (next: SeriesDef[]) => void;
  colors: Colorway[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(value[0]?.id ?? null);
  const [draft, setDraft] = useState<SeriesDef>(() => value[0] ? { ...value[0], composition: { ...value[0].composition }, colorIds: value[0].colorIds ?? colors.map((c) => c.id) } : blankSeries(colors));
  const [error, setError] = useState("");

  useEffect(() => {
    const selected = value.find((s) => s.id === selectedId);
    if (selected) setDraft({ ...selected, composition: { ...selected.composition }, colorIds: selected.colorIds ?? colors.map((c) => c.id) });
  }, [selectedId]);

  const count = Object.values(draft.composition).reduce((sum, pieces) => sum + Number(pieces || 0), 0);
  const selectedColors = draft.colorIds ?? colors.map((c) => c.id);
  const isEditing = value.some((s) => s.id === selectedId);

  const save = () => {
    const name = draft.name.trim();
    if (!name) { setError("برای سری نام وارد کنید."); return; }
    if (value.some((s) => s.id !== draft.id && s.name.trim() === name)) { setError("سری دیگری با این نام وجود دارد."); return; }
    if (count < 1) { setError("ترکیب سری باید دست‌کم یک تکه داشته باشد."); return; }
    if (!Number.isFinite(draft.pricePerSeries) || draft.pricePerSeries < 1 || draft.moqSeries < 1) { setError("قیمت و حداقل سفارش باید بزرگ‌تر از صفر باشند."); return; }
    if (!selectedColors.length) { setError("دست‌کم یک رنگ برای این سری انتخاب کنید."); return; }
    const next = { ...draft, name, pieces: count, colorIds: selectedColors };
    onChange(isEditing ? value.map((s) => s.id === next.id ? next : s) : [...value, next]);
    setSelectedId(next.id);
    setError("");
  };

  const remove = () => {
    if (!isEditing) { setDraft(blankSeries(colors)); setError(""); return; }
    const remaining = value.filter((s) => s.id !== draft.id);
    onChange(remaining);
    setSelectedId(remaining[0]?.id ?? null);
    setDraft(remaining[0] ? { ...remaining[0], composition: { ...remaining[0].composition }, colorIds: remaining[0].colorIds ?? colors.map((c) => c.id) } : blankSeries(colors));
    setError("");
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-[16px] font-extrabold">سری‌های این محصول</h3><p className="mt-1 text-[12px] leading-6 text-[var(--kv-muted)]">خریدار ترکیب سایز را تغییر نمی‌دهد. قیمت، حداقل سفارش و رنگ‌های هر سری مستقل است.</p></div>
        <Btn variant="soft" size="sm" icon={<Plus size={15} />} onClick={() => { const next = blankSeries(colors); setDraft(next); setSelectedId(null); setError(""); }}>تعریف سری جدید</Btn>
      </div>

      {value.length > 0 && <div className="grid gap-2 sm:grid-cols-2">
        {value.map((s) => <button key={s.id} onClick={() => { setSelectedId(s.id); setDraft({ ...s, composition: { ...s.composition }, colorIds: s.colorIds ?? colors.map((c) => c.id) }); setError(""); }}
          className={cn("relative rounded-[12px] border p-3 text-right transition-colors", selectedId === s.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.05]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>
          <div className="flex items-center gap-2"><b className="text-[13px]">{s.name}</b>{selectedId === s.id && <Check size={14} className="mr-auto text-[var(--kv-accent)]" />}</div>
          <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">{fmtNum(s.pieces)} تکه · حداقل {fmtNum(s.moqSeries)} سری · {s.available ? "قابل سفارش" : "غیرفعال"}</p>
          <p className="mt-1 text-[13px] font-extrabold tabular-nums">{fmtMoney(s.pricePerSeries)} / سری</p>
        </button>)}
      </div>}

      <div className="rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/30 p-4 sm:p-5">
        <p className="mb-4 text-[14px] font-bold">{isEditing ? `ویرایش ${draft.name}` : "سری جدید"}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="نام سری"><Input value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="مثلاً سری کامل" /></Field>
          <Field label="قیمت هر سری (تومان)"><Input value={draft.pricePerSeries ? String(draft.pricePerSeries) : ""} onChange={(v) => setDraft({ ...draft, pricePerSeries: Number(v.replace(/[^0-9]/g, "")) || 0 })} placeholder="۷۴۰۰۰۰۰" /></Field>
          <Field label="حداقل سفارش (سری)"><Input value={String(draft.moqSeries)} onChange={(v) => setDraft({ ...draft, moqSeries: Number(v.replace(/[^0-9]/g, "")) || 0 })} /></Field>
        </div>

        <div className="mt-5">
          <p className="mb-2.5 text-[13px] font-bold">ترکیب سایز در هر سری</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6">
            {SIZES.map((size) => {
              const n = draft.composition[size] ?? 0;
              return <div key={size} className="rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2 text-center">
                <p className="text-[12px] font-extrabold">{size}</p>
                <div className="mt-1 flex items-center justify-between">
                  <button aria-label={`کاهش سایز ${size}`} onClick={() => setDraft({ ...draft, composition: { ...draft.composition, [size]: Math.max(0, n - 1) } })} className="flex h-10 w-10 items-center justify-center rounded-[8px] hover:bg-[var(--kv-surface-2)]">−</button>
                  <b className="text-[13px] tabular-nums">{fmtNum(n)}</b>
                  <button aria-label={`افزایش سایز ${size}`} onClick={() => setDraft({ ...draft, composition: { ...draft.composition, [size]: n + 1 } })} className="flex h-10 w-10 items-center justify-center rounded-[8px] hover:bg-[var(--kv-surface-2)]">+</button>
                </div>
              </div>;
            })}
          </div>
        </div>

        <div className="mt-5">
          <p className="mb-2 text-[13px] font-bold">این سری برای کدام رنگ‌ها موجود است؟</p>
          <div className="flex flex-wrap gap-2">
            {colors.map((color) => <button key={color.id} onClick={() => setDraft({ ...draft, colorIds: selectedColors.includes(color.id) ? selectedColors.filter((id) => id !== color.id) : [...selectedColors, color.id] })}
              aria-pressed={selectedColors.includes(color.id)} className={cn("flex min-h-10 items-center gap-2 rounded-[10px] border px-3 text-[12px] font-semibold", selectedColors.includes(color.id) ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)] bg-[var(--kv-surface)]")}>
              <span className="h-4 w-4 rounded-full border border-black/15" style={{ background: color.hex }} />{color.name}
            </button>)}
          </div>
        </div>
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-[var(--kv-line)] pt-4"><div><p className="text-[13px] font-bold">امکان سفارش این سری</p><p className="text-[11px] text-[var(--kv-muted)]">غیرفعال کردن سری، بدون حذف اطلاعات آن</p></div><Switch on={draft.available} onToggle={() => setDraft({ ...draft, available: !draft.available })} /></div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[11px] bg-[var(--kv-surface)] p-3 text-[12px]">
          <span>هر سری: <b className="tabular-nums">{fmtNum(count)} تکه</b></span>
          <span>حداقل خرید: <b className="tabular-nums">{fmtNum(count * Math.max(draft.moqSeries, 0))} تکه</b></span>
          <span>قیمت حداقل خرید: <b className="tabular-nums">{fmtMoney(draft.pricePerSeries * Math.max(draft.moqSeries, 0))}</b></span>
        </div>
        {error && <p role="alert" className="mt-3 text-[12px] text-[var(--kv-danger)]">{error}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Btn variant="accent" size="sm" icon={<Check size={14} />} onClick={save}>{isEditing ? "ثبت تغییرات سری" : "افزودن سری"}</Btn>
          {(isEditing || draft.name) && <Btn variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={remove}>{isEditing ? "حذف سری" : "پاک کردن فرم"}</Btn>}
        </div>
      </div>
    </div>
  );
}