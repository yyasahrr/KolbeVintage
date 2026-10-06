import { useEffect, useState } from 'react';
import { studioApi, type RegistryComponent } from '../data/experience-api';
import { Btn, Empty, ErrorState, LoadingState } from '../components/primitives';
import { cmsError } from './cms-api';

const FEATURED = new Set(['countdown', 'banner', 'promotion_banner', 'hero', 'category_card', 'product_card', 'installment_card']);

export function CmsComponentCatalog() {
  const [items, setItems] = useState<RegistryComponent[] | null>(null);
  const [error, setError] = useState('');
  const load = () => { setError(''); void studioApi.registry().then(r => setItems(r.items.filter(c => c.active && FEATURED.has(c.code)))).catch(e => setError(cmsError(e))); };
  useEffect(load, []);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <LoadingState />;
  return <section className="space-y-4">
    <div><h3 className="text-base font-bold">کامپوننت‌های سایت</h3><p className="mt-1 text-sm leading-7 text-[var(--kv-muted)]">توسعه‌دهنده نوع کامپوننت را با هر نسخه اضافه می‌کند. در «صفحات» می‌توانید نمونه‌های آن را به صفحه بیفزایید و محتوا و ظاهرشان را تنظیم کنید.</p></div>
    {!items.length ? <Empty title="کامپوننتی در دسترس نیست" desc="پس از نصب نسخه و اجرای مهاجرت‌های CMS دوباره تلاش کنید." action={<Btn onClick={load}>بارگذاری دوباره</Btn>} /> :
      <div className="divide-y divide-[var(--kv-line)] rounded-xl border border-[var(--kv-line)]">{items.map(c => <div key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm"><b className="min-w-0 flex-1">{c.title.replace(/\s*\([^)]*\)/g, '')}</b><span className="text-xs text-[var(--kv-muted)]">قابل تنظیم در ویرایشگر صفحات</span></div>)}</div>}
    <p className="text-xs text-[var(--kv-muted)]">لیبل اقساطی از بخش «کارت محصول» تنظیم می‌شود و فقط برای کالای دارای شرایط اقساط نمایش داده خواهد شد.</p>
  </section>;
}
