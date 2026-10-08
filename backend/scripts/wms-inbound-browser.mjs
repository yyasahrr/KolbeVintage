/**
 * Prompt 6 in a REAL browser + REAL API (no mocks, no DOM fixture injection).
 *
 * Covers the order-bound warehouse workspace «دریافت، کنترل کیفیت و تجمیع»
 * (`#/admin/inbound-ops` → the WMS hub's wholesale sub-tab «دریافت و تجمیع سفارش‌های مادر»):
 *   • the deep link resolves through the existing redirect table and the hub keeps the exact IA
 *     (four primary tabs + the wholesale sub-tabs);
 *   • every dashboard counter rendered in the DOM is compared with the numbers the server returned
 *     to the SAME browser session — the UI may neither invent nor round a counter;
 *   • each counter card drills into a server-filtered work queue (asserted by watching the real
 *     requests the browser makes while opening the queue);
 *   • all five task views render server state without the error boundary or a blank body;
 *   • the workspace is Persian/RTL and leaks no implementation term (raw enum, SQL column, UUID);
 *   • the endpoints stay protected for a forged caller — the frontend is never the authority;
 *   • responsive sweep at 360/390/768/1024/1280/1440 px: no horizontal overflow, mobile tap
 *     targets stay large.
 */
export async function wmsInboundSmoke({ page, check, base, text, clickByText }) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const workspaceUrl = `${base}/#/admin/inbound-ops`;
  const seen = [];
  const listener = (request) => {
    const index = request.url().indexOf('/api/v1');
    if (index >= 0) seen.push(`${request.method()} ${request.url().slice(index)}`);
  };
  page.on('request', listener);
  const saw = (fragment) => seen.some((entry) => entry.includes(fragment));
  const lastMatching = (fragment) => seen.filter((entry) => entry.includes(fragment)).slice(-1)[0] ?? `no ${fragment} request`;
  const waitForText = async (needle, attempts = 30) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if ((await text()).includes(needle)) return true;
      await sleep(400);
    }
    return false;
  };
  /** The Prompt 6 workspace root: the container that owns the five task-view tabs. */
  const workspaceText = async () => page.evaluate(() => {
    const tab = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.innerText.trim() === 'داشبورد انبار');
    const root = tab?.parentElement?.parentElement;
    return root ? root.innerText : document.body.innerText;
  });
  /** Placeholder text lives in an attribute, never in innerText. */
  const hasInput = (fragment) => page.evaluate((needle) => [...document.querySelectorAll('input, textarea')]
    .some((element) => (element.getAttribute('placeholder') ?? '').includes(needle)), fragment);
  const counterCards = () => page.evaluate(() => [...document.querySelectorAll('button[aria-label]')]
    .map((button) => button.getAttribute('aria-label'))
    .filter((label) => label && /: \d+$/.test(label)));

  try {
    /* ------------------------------- deep link lands ------------------------------- */
    await page.setViewport({ width: 1440, height: 1100 });
    await page.goto(workspaceUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    let landed = await waitForText('داشبورد انبار');
    if (!landed) {
      // A hash-only navigation can be swallowed when the console was already mounted; reload once.
      await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
      landed = await waitForText('داشبورد انبار');
    }
    check('deep link #/admin/inbound-ops lands on the warehouse inbound workspace', landed);
    if (!landed) {
      // Fall back to the operator path (WMS hub → انبار عمده → the workspace sub-tab) so the rest of
      // the sweep still runs against the real surface instead of an unrelated page.
      await clickByText('انبار عمده');
      await sleep(700);
      await clickByText('دریافت و تجمیع');
      landed = await waitForText('داشبورد انبار');
    }
    check('the workspace is reachable from the WMS hub sub-tabs', landed);
    check('the dashboard states that counters come from real records (no vanity metrics)',
      await waitForText('از رکوردهای واقعی انبار محاسبه'));
    check('the dashboard surfaces the server inbound-delay policy',
      (await text()).includes('آستانه تأخیر محموله'));
    check('the dashboard really loaded from the server endpoint', saw('/admin/wms/dashboard'), lastMatching('/admin/wms/dashboard'));

    /* ----------------------- the warehouse IA is unchanged ----------------------- */
    const hubStrip = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.innerText.trim().startsWith('انبار عمده'));
      const strip = button?.parentElement;
      return strip ? [...strip.children].map((child) => child.innerText.trim()) : null;
    });
    const stripText = (hubStrip ?? []).join(' | ');
    check('the WMS hub keeps exactly its four primary tabs (no duplicate top-level workflow)',
      Array.isArray(hubStrip) && hubStrip.length === 4
        && stripText.includes('خرده') && stripText.includes('نقل') && stripText.includes('انبار عمده') && stripText.includes('تنظیمات'),
      `tabs: ${stripText}`);
    const subStrip = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.innerText.trim() === 'درخواست‌های تأمین‌کنندگان');
      const strip = button?.parentElement;
      return strip ? [...strip.children].map((child) => child.innerText.trim()) : null;
    });
    check('the Prompt 6 workspace lives inside the existing wholesale sub-tabs',
      Array.isArray(subStrip) && subStrip.some((label) => label.includes('ورودی انبار')) && subStrip.length >= 5,
      `${(subStrip ?? []).length} sub-tabs`);

    /* ------------------- counters are the server's own numbers ------------------- */
    const counterKeys = ['arriving', 'awaiting_receiving', 'awaiting_qc', 'damaged', 'open_exceptions',
      'awaiting_consolidation', 'ready_for_packing', 'ready_for_dispatch', 'delayed_inbound'];
    const serverCounters = await page.evaluate(async () => {
      const token = localStorage.getItem('kolbe-access-token');
      const response = await fetch('/api/v1/admin/wms/dashboard', { headers: { authorization: `Bearer ${token}` } });
      return response.ok ? { status: response.status, counters: (await response.json()).counters } : { status: response.status };
    });
    check('the dashboard endpoint answers the browser session with real counters',
      serverCounters.status === 200 && Boolean(serverCounters.counters), `HTTP ${serverCounters.status}`);
    const labels = await counterCards();
    check('the dashboard renders one card per server counter', labels.length === counterKeys.length, `${labels.length} cards`);
    const required = ['محموله در راه', 'در انتظار دریافت', 'کنترل کیفیت', 'آسیب', 'نیازمند بررسی',
      'آماده تجمیع', 'آماده بسته‌بندی', 'آماده ارسال', 'تأخیر'];
    const missingLabels = required.filter((fragment) => !labels.some((label) => label.includes(fragment)));
    check('the §25 counter vocabulary is used on the cards', missingLabels.length === 0, missingLabels.join(' | '));
    const domValues = labels.map((label) => Number(label.slice(label.lastIndexOf(': ') + 2))).sort((a, b) => a - b);
    const serverValues = counterKeys.map((key) => Number(serverCounters.counters?.[key] ?? 0)).sort((a, b) => a - b);
    check('every rendered counter equals a server counter (no client-side arithmetic or invention)',
      domValues.length === serverValues.length && domValues.every((value, index) => value === serverValues[index]),
      `dom=[${domValues.join(',')}] server=[${serverValues.join(',')}]`);

    /* --------------------- cards drill into server-filtered queues --------------------- */
    /** Cards live on the dashboard: always return there before drilling, exactly like an operator. */
    const clickCard = async (fragment) => {
      await clickByText('داشبورد انبار');
      for (let attempt = 0; attempt < 20 && (await counterCards()).length === 0; attempt += 1) await sleep(300);
      return page.evaluate((needle) => {
        const button = [...document.querySelectorAll('button[aria-label]')]
          .find((candidate) => candidate.getAttribute('aria-label')?.includes(needle));
        if (!button) return false;
        button.click();
        return true;
      }, fragment);
    };

    seen.length = 0;
    const clickedReceiving = await clickCard('در انتظار دریافت');
    const receivingInput = await hasInput('شماره محموله');
    check('«در انتظار دریافت» opens the receiving queue filtered server-side',
      clickedReceiving && receivingInput && saw('/admin/wms/inbound-shipments') && saw('awaitingReceiving=true'),
      lastMatching('inbound-shipments'));

    seen.length = 0;
    const clickedQc = await clickCard('کنترل کیفیت');
    const qcInput = await hasInput('شماره محموله');
    check('«کنترل کیفیت» opens the QC queue filtered server-side',
      clickedQc && qcInput && saw('/admin/wms/inbound-shipments') && saw('awaitingQc=true'),
      lastMatching('inbound-shipments'));
    check('receiving and QC are separate queues (QC never reuses the receiving filter)',
      saw('awaitingQc=true') && !saw('awaitingReceiving=true'));

    seen.length = 0;
    const clickedExceptions = await clickCard('نیازمند بررسی');
    const exceptionQueue = await waitForText('موارد باز');
    check('«نیازمند بررسی» opens the Exception Center on fulfillment_exceptions',
      clickedExceptions && exceptionQueue && saw('/admin/wms/exceptions') && saw('status=open'),
      lastMatching('exceptions'));

    seen.length = 0;
    const clickedConsolidation = await clickCard('آماده تجمیع');
    let queueLoaded = false;
    for (let attempt = 0; attempt < 25 && !queueLoaded; attempt += 1) {
      const body = await workspaceText();
      queueLoaded = body.includes('کارگاه تجمیع') || body.includes('سفارش مادری در این وضعیت نیست');
      if (!queueLoaded) await sleep(300);
    }
    const rows = await page.evaluate(() => [...document.querySelectorAll('button')]
      .filter((button) => button.innerText.includes('کارگاه تجمیع')).length);
    const serverRows = await page.evaluate(async () => {
      const token = localStorage.getItem('kolbe-access-token');
      const response = await fetch('/api/v1/admin/wms/consolidation-queue?limit=60', { headers: { authorization: `Bearer ${token}` } });
      return response.ok ? (await response.json()).items.length : -1;
    });
    check('«آماده تجمیع» opens the consolidation queue from the server queue endpoint',
      clickedConsolidation && queueLoaded && saw('/admin/wms/consolidation-queue'), lastMatching('consolidation-queue'));
    check('the consolidation queue shows a row per server row (deep-linkable work queue)',
      serverRows >= 0 && (serverRows === 0 ? await waitForText('سفارش مادری در این وضعیت نیست') : rows === serverRows),
      `rendered=${rows} server=${serverRows}`);

    /* ------------------------------ five task views ------------------------------ */
    const views = [
      { tab: 'داشبورد انبار', probe: async () => (await counterCards()).length > 0, label: 'dashboard cards' },
      { tab: 'در انتظار دریافت', probe: () => hasInput('شماره محموله'), label: 'receiving queue' },
      { tab: 'کنترل کیفیت', probe: () => hasInput('شماره محموله'), label: 'QC queue' },
      { tab: 'نیازمند بررسی', probe: async () => (await workspaceText()).includes('موارد باز'), label: 'exception center' },
      { tab: 'تجمیع و ارسال', probe: async () => {
        const body = await workspaceText();
        return body.includes('کارگاه تجمیع') || body.includes('سفارش مادری در این وضعیت نیست');
      }, label: 'consolidation queue' },
    ];
    for (const view of views) {
      await clickByText(view.tab);
      await sleep(600);
      const body = await workspaceText();
      const crashed = body.includes('خطایی در این بخش رخ داد');
      const rendered = await view.probe();
      check(`task view «${view.tab}» renders its server-backed ${view.label}`,
        rendered && !crashed && body.trim().length > 120,
        crashed ? 'error boundary shown' : `${body.trim().length} chars`);
    }

    /* ---------------------------- Persian, RTL, no leaks ---------------------------- */
    await clickByText('داشبورد انبار');
    await sleep(400);
    const rtl = await page.evaluate(() => ({
      dir: document.documentElement.getAttribute('dir') ?? getComputedStyle(document.documentElement).direction,
      body: getComputedStyle(document.body).direction,
    }));
    check('the operational workspace is RTL', rtl.dir === 'rtl' && rtl.body === 'rtl', JSON.stringify(rtl));
    const workspaceBody = await workspaceText();
    const vocabulary = ['در انتظار دریافت', 'کنترل کیفیت', 'نیازمند بررسی', 'آماده تجمیع', 'ارسال', 'آسیب'];
    const fullBody = await text();
    const missingVocabulary = vocabulary.filter((word) => !workspaceBody.includes(word) && !fullBody.includes(word));
    check('the §25 Persian label vocabulary is used (محموله ورودی / کسری / آسیب‌دیده / کنترل کیفیت …)',
      missingVocabulary.length === 0, missingVocabulary.join(' | '));
    const leaks = ['supplier_external', 'qc_passed_series', 'lost_inbound', 'oms_inbound_shipment',
      'order_source_allocations', 'fulfillment_exceptions', 'received_series', 'master_order_id']
      .filter((token) => workspaceBody.includes(token));
    check('no SQL column, raw enum or implementation term leaks into the workspace',
      leaks.length === 0, leaks.join(' | '));
    const uuids = workspaceBody.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    check('no raw UUID is rendered anywhere in the workspace', uuids.length === 0, uuids.slice(0, 3).join(' | '));

    /* --------------------- the frontend is never the authority --------------------- */
    const forged = await page.evaluate(async () => {
      const response = await fetch('/api/v1/admin/wms/dashboard', { headers: { authorization: 'Bearer forged-token' } });
      return response.status;
    });
    check('warehouse endpoints reject a forged caller (server-side permissions)', forged === 401 || forged === 403, `HTTP ${forged}`);

    /* --------------------------------- responsive --------------------------------- */
    const overflow = [];
    for (const width of [360, 390, 768, 1024, 1280, 1440]) {
      await page.setViewport({ width, height: 900 });
      await clickByText('داشبورد انبار');
      await sleep(350);
      const measured = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        cards: [...document.querySelectorAll('button[aria-label]')]
          .filter((button) => /: \d+$/.test(button.getAttribute('aria-label') ?? ''))
          .map((button) => Math.round(button.getBoundingClientRect().height)),
      }));
      if (measured.scrollWidth > measured.clientWidth + 1) overflow.push(`${width}px: ${measured.scrollWidth}>${measured.clientWidth}`);
      if (width <= 390 && measured.cards.some((height) => height < 80)) {
        check(`dashboard tap targets stay ≥80px tall at ${width}px`, false, `heights: ${measured.cards.join(',')}`);
      }
    }
    check('the dashboard never overflows horizontally at 360/390/768/1024/1280/1440 px',
      overflow.length === 0, overflow.join(' | '));

    const queueOverflow = [];
    for (const width of [360, 768, 1440]) {
      await page.setViewport({ width, height: 900 });
      await clickByText('در انتظار دریافت');
      await sleep(500);
      const measured = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (measured.scrollWidth > measured.clientWidth + 1) queueOverflow.push(`${width}px: ${measured.scrollWidth}>${measured.clientWidth}`);
    }
    check('the receiving/QC work queue never overflows horizontally at 360/768/1440 px',
      queueOverflow.length === 0, queueOverflow.join(' | '));

    await page.setViewport({ width: 1440, height: 1100 });
    await clickByText('داشبورد انبار');
    await sleep(300);
  } finally {
    page.off('request', listener);
  }
}
