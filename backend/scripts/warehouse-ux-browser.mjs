/** Real browser + real API, with isolated receipt fixtures; no balance mutation mocks. */
export async function warehouseUxSmoke({ page, check, apiPort, clickByText, setInput, text, waitForText: pollText }) {
  const waitForText = async (needle) => { if (!await pollText(needle)) throw new Error(`Warehouse UI did not render ${needle}: ${(await text()).slice(-1200)}`); };
  const token = await page.evaluate(() => localStorage.getItem('kolbe-access-token'));
  const request = async (path, payload, key) => {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1${path}`, { method: payload ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(result)}`); return result;
  };
  const suffix = Date.now();
  const warehouses = (await request('/warehouses')).items;
  const warehouse = warehouses[0];
  const productName = `محصول آزمون انبار ${suffix}`;
  const product = await request('/products', { name: productName, brand: 'UX', category: 'کفش', cashPriceRial: '3000000', wholesalePriceRial: '2000000', variants: [{ color: 'مشکی', size: '41' }] });
  const variant = product.variants[0];
  const createReceipt = (quantity, batch) => request('/inventory/receipts', { variantId: variant.id, warehouseId: warehouse.id, inventoryDomain: 'retail', quantity, batchReference: batch }, `ux-${suffix}-${batch}`);
  const initial = await createReceipt(12, 'INITIAL');
  await request(`/inventory/receipts/${initial.id}/receive`, { receivedQuantity: 12 });
  const a = await createReceipt(5, 'CTN-A');
  const b = await createReceipt(3, 'CTN-B');
  await page.reload(); await waitForText('کنسول مدیریت');
  // Refresh sidebar warehouse module after reload defaults back to its primary tab.
  await page.evaluate(() => [...document.querySelectorAll('aside button')].find((button) => button.textContent.includes('انبار و موجودی (WMS)'))?.click());
  // WMS opens on physical retail inventory; product lifecycle is a separate Product Studio module.
  await clickByText('خرده‌فروشی');
  await page.waitForSelector('input[placeholder="جست‌وجو بر اساس نام، SKU، رنگ یا سایز…"]');
  await page.type('input[placeholder="جست‌وجو بر اساس نام، SKU، رنگ یا سایز…"]', String(suffix));
  await waitForText(productName);
  // §3/§4: settings is now the FOURTH primary tab (not a drawer) and must stay configuration-only.
  await clickByText('تنظیمات انبار');
  await waitForText('انبار انتخاب‌شده');
  const settingsText = await text();
  check('warehouse settings tab has configuration and no operational forms or balances', settingsText.includes('انبار انتخاب‌شده') && settingsText.includes('مکان‌ها') && settingsText.includes('فیلتر گزارش موجودی کم') && !/ثبت رسید|ثبت اصلاح|ثبت انتقال|تراز موجودی/.test(settingsText));
  check('low stock report explicitly describes global non-persisted scope', settingsText.includes('همه انبارها و دامنه‌ها') && settingsText.includes('ذخیره نمی‌شود'));
  await setInput('کد مکان', `UX-${String(suffix).slice(-5)}`); await setInput('نام مکان', 'قفسه آزمون'); await clickByText('افزودن مکان'); await waitForText('مکان انبار ثبت شد');
  check('location creation refreshes readable code/name/status list', (await text()).includes('قفسه آزمون') && (await text()).includes('فعال'));
  // Back to the retail operations tab (tab switch unmounts the table, so search again).
  await clickByText('خرده‌فروشی');
  await page.waitForSelector('input[placeholder="جست‌وجو بر اساس نام، SKU، رنگ یا سایز…"]');
  await page.type('input[placeholder="جست‌وجو بر اساس نام، SKU، رنگ یا سایز…"]', String(suffix));
  await waitForText(productName);
  const productRow = async () => page.evaluate((name) => [...document.querySelectorAll('tbody tr')].find((row) => row.textContent.includes(name))?.textContent ?? '', productName);
  check('incoming product exposes visible Receive action', (await productRow()).includes('دریافت کالا'));
  await page.evaluate((name) => [...document.querySelectorAll('tbody tr')].find((row) => row.textContent.includes(name))?.click(), productName);
  const action = async (value) => {
    // The operations select is disabled while the hub is busy (refresh in flight);
    // change events on disabled elements are silently dropped — wait until enabled.
    await page.waitForFunction((sku) => {
      const el = document.querySelector(`select[aria-label="عملیات ${sku}"]`);
      return Boolean(el) && !el.disabled;
    }, { timeout: 30000 }, variant.sku);
    await page.select(`select[aria-label="عملیات ${variant.sku}"]`, value);
  };
  const calls = [];
  const listener = (req) => { if (req.url().includes('/api/v1/')) calls.push({ method: req.method(), url: req.url(), body: req.postData() }); };
  page.on('request', listener);
  await action('adjust'); await waitForText('نوع تغییر');
  check('adjustment has increase/decrease and numeric positive quantity', await page.evaluate(() => document.body.textContent.includes('افزایش +') && document.body.textContent.includes('کاهش −') && document.querySelector('input[aria-label="مقدار"]')?.type === 'number' && document.querySelector('input[aria-label="مقدار"]')?.min === '1'));
  await clickByText('کاهش −'); await setInput('مقدار', '3');
  check('decrease preview shows current 12, delta -3, result 9', (await text()).includes('موجودی فعلی: ۱۲') && (await text()).includes('-۳') && (await text()).includes('موجودی جدید: ۹'));
  await setInput('مقدار', '0');
  check('zero quantity disables adjustment submit', await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'ثبت سند')?.disabled));
  await setInput('مقدار', '13');
  check('invalid resulting inventory disables submit with validation', (await text()).includes('نمی‌تواند') && await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'ثبت سند')?.disabled));
  await setInput('مقدار', '3'); await clickByText('ثبت سند'); await waitForText('سند اصلاح موجودی ثبت شد');
  const adjustmentCall = calls.find((call) => call.url.includes('/inventory/adjustments') && call.method === 'POST');
  check('decrease sends signed delta -3 with audited reason/reference/domain', !!adjustmentCall && JSON.parse(adjustmentCall.body).delta === -3 && !!JSON.parse(adjustmentCall.body).reason && !!JSON.parse(adjustmentCall.body).reference && JSON.parse(adjustmentCall.body).inventoryDomain === 'retail');
  await action('adjust'); await setInput('مقدار', '2'); await clickByText('افزایش +');
  check('increase preview computes resulting stock', (await text()).includes('موجودی جدید: ۱۱'));
  await clickByText('ثبت سند'); await waitForText('سند اصلاح موجودی ثبت شد');
  check('increase sends signed delta +2', calls.some((call) => call.url.includes('/inventory/adjustments') && call.method === 'POST' && JSON.parse(call.body).delta === 2));
  // Explicit selection is mandatory: opening Receive must not submit either receipt.
  await action('receive'); await waitForText('رسیدهای در انتظار');
  check('multiple pending receipts show explicit selector', (await text()).includes(a.reference) && (await text()).includes(b.reference) && (await text()).includes('CTN-A') && (await text()).includes('CTN-B'));
  check('opening selector never mutates stock', !calls.some((call) => call.url.includes('/receive') && call.method === 'POST'));
  await clickByText(a.reference); await waitForText('تعداد واقعی دریافتی');
  check('receive modal defaults to expected quantity and shows warehouse context', await page.$eval('input[aria-label="تعداد واقعی دریافتی"]', (input) => input.value === '5') && (await text()).includes(warehouse.name));
  await setInput('تعداد واقعی دریافتی', '4');
  check('receive shortage preview is explicit', (await text()).includes('کسری: ۱') && (await text()).includes('کسری به‌صورت مغایرت ثبت می‌شود'));
  await clickByText('ثبت دریافت'); await waitForText('کسری ۱ عدد ثبت شد');
  const after = (await request(`/inventory?warehouseId=${warehouse.id}&inventoryDomain=retail`)).items.find((item) => item.variant_id === variant.id);
  check('receive increases on-hand by actual and clears incoming for that receipt', after.on_hand === 15 && after.incoming === 3);
  check('receive submits existing receipt endpoint and refreshes inventory', calls.some((call) => call.url.includes(`/receipts/${a.id}/receive`) && JSON.parse(call.body).receivedQuantity === 4) && calls.filter((call) => call.method === 'GET' && call.url.includes('/inventory?')).length >= 3);
  check('remaining receipt incoming is visible after refresh', (await productRow()).includes('+۳ در راه'));
  await action('receive'); await waitForText(`دریافت رسید ${b.reference}`);
  check('single pending receipt opens receive modal directly', !(await text()).includes('یک رسید را برای دریافت انتخاب کنید'));
  // Mirror the first receipt's flow: the submit button stays disabled until the modal's
  // async warehouse context resolves, so wait for the fully-ready modal before clicking.
  await waitForText('تعداد واقعی دریافتی'); await waitForText(warehouse.name);
  const receiveClicked = await clickByText('ثبت دریافت');
  // Outcome-based wait: flash toasts expire too fast under constrained CPU, so verify the
  // REAL outcome — modal closed + receipt applied to on-hand via the API (database truth).
  let modalClosed = false;
  for (let i = 0; i < 24 && !modalClosed; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    modalClosed = !(await text()).includes(`دریافت رسید ${b.reference}`);
  }
  const afterB = (await request(`/inventory?warehouseId=${warehouse.id}&inventoryDomain=retail`)).items.find((item) => item.variant_id === variant.id);
  check('second receipt fully received — modal closes, on-hand 18, incoming 0 (API truth)',
    receiveClicked && modalClosed && afterB.on_hand === 18 && afterB.incoming === 0);
  check('incoming and Receive action disappear after final receipt', !(await productRow()).includes('در راه') && !(await productRow()).includes('دریافت کالا'));
  const final = (await request(`/inventory?warehouseId=${warehouse.id}&inventoryDomain=retail`)).items.find((item) => item.variant_id === variant.id);
  check('on-hand reflects both independent receipt confirmations', final.on_hand === 18 && final.incoming === 0);
  check('operations column uses compact native menu', await page.$eval(`select[aria-label="عملیات ${variant.sku}"]`, (select) => select.options[0].text.includes('عملیات') && ![...select.options].some((option) => option.value === 'receive')));
  // Sale toggle is now a SCOPE modal (variant/color/product + تأیید و اعمال) — drive it like an operator.
  await action('sale'); await waitForText(`عرضه در کاتالوگ — ${productName}`);
  check('sale modal locks scope to the entry variant with explicit preview', (await text()).includes('فقط همین تنوع') && (await text()).includes(`توقف عرضه برای: فقط تنوع مشکی / 41 (${variant.sku})`));
  await clickByText('تأیید و اعمال');
  // The operations entry is static («وضعیت عرضه در کاتالوگ…») in the scope-modal design, so assert the
  // OUTCOME: the variant-level sale flag flips server-side (API/database truth).
  const saleFlag = async () => {
    const item = (await request(`/inventory?warehouseId=${warehouse.id}&inventoryDomain=retail`)).items.find((it) => it.variant_id === variant.id);
    return item?.variant_sale_enabled ?? true;
  };
  let stopped = false;
  for (let i = 0; i < 24 && !stopped; i += 1) { await new Promise((resolve) => setTimeout(resolve, 400)); stopped = (await saleFlag()) === false; }
  check('variant-scope sale stop persists server-side', stopped);
  await action('sale'); await waitForText(`عرضه در کاتالوگ — ${productName}`);
  check('sale modal defaults to re-activation when the variant is stopped', (await text()).includes('شروع عرضه برای'));
  await clickByText('تأیید و اعمال');
  let active = false;
  for (let i = 0; i < 24 && !active; i += 1) { await new Promise((resolve) => setTimeout(resolve, 400)); active = (await saleFlag()) === true; }
  check('variant-scope sale re-activation persists server-side', active);
  page.off('request', listener);
}
