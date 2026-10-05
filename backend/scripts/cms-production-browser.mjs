import { randomUUID } from 'node:crypto';
export async function cmsProductionBrowser({page,check,adminApi,shot}) {
  const pause=(ms=300)=>new Promise(r=>setTimeout(r,ms));
  const visible=el=>!!(el.getBoundingClientRect().width&&el.getBoundingClientRect().height);
  const click=async(text,dialog=false)=>{
    const ok=await page.evaluate((text,dialog)=>{
      const visible=el=>!!(el.getBoundingClientRect().width&&el.getBoundingClientRect().height);
      const scope=dialog?[...document.querySelectorAll('[role=dialog]')].filter(visible).at(-1):document;
      const button=[...(scope?.querySelectorAll('button')??[])].find(b=>b.innerText.trim()===text&&!b.disabled&&visible(b));if(!button)return false;button.click();return true;
    },text,dialog);if(!ok)throw new Error(`CMS button not available: ${text}`);await pause();
  };
  const field=async(label,value,kind='input')=>{
    const ok=await page.evaluate((label,value,kind)=>{
      const visible=el=>!!(el.getBoundingClientRect().width&&el.getBoundingClientRect().height);
      const scope=[...document.querySelectorAll('[role=dialog]')].filter(visible).at(-1)??document;
      const wrapper=[...scope.querySelectorAll('label')].find(el=>el.querySelector('span')?.textContent.trim()===label&&visible(el));
      const input=wrapper?.querySelector(kind);if(!input)return false;
      const proto=kind==='textarea'?HTMLTextAreaElement.prototype:kind==='select'?HTMLSelectElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true;
    },label,value,kind);if(!ok)throw new Error(`CMS field missing: ${label}`);await pause(80);
  };
  const wait=async(needle)=>{await page.waitForFunction(needle=>document.body.innerText.includes(needle),{timeout:15000},needle);};
  const close=async()=>{await page.keyboard.press('Escape');await pause();};
  const suffix=randomUUID().slice(0,8),title=`آزمون محتوا ${suffix}`,path=`/browser/${suffix}`;
  await click('+ صفحه جدید');
  await field('عنوان',title);await field('مسیر یکتا',path);await click('ایجاد پیش‌نویس',true);await wait(title);
  const listing=await adminApi(`/admin/cms/pages?search=${encodeURIComponent(title)}`);const row=listing.body.items.find(p=>p.title===title);
  check('CMS UI creates a PostgreSQL draft page with independent path',!!row&&row.status==='draft');
  // Open the matching row rather than another page's edit button.
  await page.evaluate(title=>{const article=[...document.querySelectorAll('article')].find(a=>a.innerText.includes(title));const button=[...article.querySelectorAll('button')].find(b=>b.innerText==='ویرایش');button.focus();button.click();},title);
  await wait('افزودن بخش');
  await page.evaluate(()=>document.querySelector('[role=dialog] [data-autofocus]').focus());
  await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');
  check('CMS workspace Shift+Tab traps keyboard focus',await page.evaluate(()=>document.querySelector('[role=dialog]').contains(document.activeElement)));
  await page.keyboard.press('Tab');
  check('CMS workspace Tab keeps focus inside including preview iframe',await page.evaluate(()=>document.querySelector('[role=dialog]').contains(document.activeElement)));
  const library=await page.evaluate(()=>{const label=[...document.querySelectorAll('label')].find(l=>l.innerText.startsWith('افزودن بخش'));return [...label.querySelectorAll('option')].map(o=>o.value);});
  await field('افزودن بخش',library.find(s=>/هیرو اصلی|هدر اصلی/.test(s)),'select');await click('+ افزودن بخش',true);
  await wait('تیتر اصلی');await field('تیتر اصلی *','نسخه نخست مرورگر','textarea');await pause(1600);
  let d=(await adminApi(`/admin/cms/pages/${row.id}/draft`)).body;
  check('CMS autosave persists registry-based Hero fields as draft',d.sections[0]?.payload.title==='نسخه نخست مرورگر');
  const publicBefore=await page.evaluate(async code=>(await fetch(`/api/v1/site/pages/${code}`)).status,row.code);
  check('CMS editing a new page does not publish',publicBefore===404);
  await click('بررسی و انتشار',true);await wait('آماده انتشار');await click('تأیید انتشار فوری',true);await pause(1000);
  let live=await adminApi(`/site/pages/${row.code}`);
  check('CMS explicit publish freezes the persisted draft',live.body.sections[0]?.payload.title==='نسخه نخست مرورگر');
  await field('تیتر اصلی *','نسخه دوم مرورگر','textarea');await pause(1400);
  live=await adminApi(`/site/pages/${row.code}`);d=(await adminApi(`/admin/cms/pages/${row.id}/draft`)).body;
  check('CMS draft edit and public snapshot remain distinct across UI/API/data',d.sections[0]?.payload.title==='نسخه دوم مرورگر'&&live.body.sections[0]?.payload.title==='نسخه نخست مرورگر');

  await page.setRequestInterception(true);
  let failDraft=true,failJournal=false;
  const intercept=request=>{if((failDraft&&request.method()==='PUT'&&request.url().endsWith('/draft'))||(failJournal&&request.method()==='POST'&&request.url().endsWith('/editorial')))request.abort('failed');else request.continue();};
  page.on('request',intercept);
  await field('تیتر اصلی *','ذخیره ناموفق مرورگر','textarea');await wait('ذخیره انجام نشد');
  check('CMS failed autosave is visible and blocks publish',await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.innerText==='بررسی و انتشار')?.disabled===true));
  failDraft=false;await click('تلاش دوباره',true);await pause(1500);
  d=(await adminApi(`/admin/cms/pages/${row.id}/draft`)).body;
  check('CMS save retry persists latest content without publishing',d.sections[0]?.payload.title==='ذخیره ناموفق مرورگر');
  await adminApi(`/admin/cms/sections/${d.sections[0].id}`,'PATCH',{title:'ویرایش هم‌زمان'});
  await field('تیتر اصلی *','تغییر پس از تعارض','textarea');await wait('این صفحه از زمان باز شدن');
  check('CMS concurrent edit conflicts are surfaced and never overwrite the newer server draft',
    (await adminApi(`/admin/cms/pages/${row.id}/draft`)).body.sections[0].title==='ویرایش هم‌زمان');
  await click('بارگذاری نسخهٔ سرور و کنارگذاشتن تغییرات ذخیره‌نشده',true);await pause(1000);

  for(const width of [360,390,768,1024,1280,1440]) {
    await page.setViewport({width,height:900});await pause(200);
    for(const tab of ['بخش‌ها','ویژگی‌ها','پیش‌نمایش']) {if(width<1280)await click(tab,true);
      const fit=await page.evaluate(()=>{const dialogs=[...document.querySelectorAll('[role=dialog]')];const box=dialogs.at(-1).getBoundingClientRect();return {doc:document.documentElement.scrollWidth<=innerWidth+1,dialog:box.left>=-1&&box.right<=innerWidth+1&&box.top>=-1&&box.bottom<=innerHeight+1,content:dialogs.at(-1).scrollWidth<=dialogs.at(-1).clientWidth+1};});
      check(`CMS workspace ${width}px ${tab}: document, dialog and content fit`,fit.doc&&fit.dialog&&fit.content,JSON.stringify(fit));
    }
    await click('بررسی و انتشار',true);await wait('تفاوت با نسخه');
    check(`CMS publish checklist ${width}px fits viewport`,await page.evaluate(()=>{const d=[...document.querySelectorAll('[role=dialog]')].at(-1),r=d.getBoundingClientRect();return r.width<=innerWidth+1&&r.height<=innerHeight+1&&d.scrollWidth<=d.clientWidth+1;}));
    await close();await shot(`cms-workspace-${width}`);
  }
  await page.setViewport({width:1440,height:1100});
  await click('تاریخچه',true);await wait('نسخه');await click('پیش‌نمایش نسخه',true);await pause();
  check('CMS version preview uses an iframe without restoring or publishing',await page.$('iframe[data-device]')!==null);
  await click('تاریخچه',true);await click('بازگردانی به پیش‌نویس',true);await pause(1000);
  d=(await adminApi(`/admin/cms/pages/${row.id}/draft`)).body;
  check('CMS restore returns historical content to draft',d.sections[0].payload.title==='نسخه نخست مرورگر');
  await close();check('CMS Escape closes workspace and restores focus',await page.evaluate(()=>!document.querySelector('[role=dialog]')&&document.activeElement?.tagName==='BUTTON'));

  await click('مجله');await click('+ مطلب جدید');await field('عنوان',`مجله ${suffix}`);await field('نشانی مطلب',`journal-${suffix}`);await field('متن مطلب','متن مستقل مجله','textarea');
  failJournal=true;await click('ذخیره پیش‌نویس',true);await wait('تلاش دوباره برای ذخیره');
  check('CMS editorial API failure keeps the editor open and shows an error',await page.evaluate(()=>!!document.querySelector('[role=dialog] [role=alert]')));
  check('CMS editorial failure never creates a browser persistence fallback',await page.evaluate(()=>localStorage.getItem('kolbe-editorial-media-v1')===null));
  failJournal=false;await click('تلاش دوباره برای ذخیره',true);await pause(700);
  const journal=(await adminApi(`/admin/editorial?q=${encodeURIComponent(`مجله ${suffix}`)}`)).body.items;
  check('CMS Journal retry persists a real server draft',journal.some(p=>p.title===`مجله ${suffix}`&&p.status==='draft'));
  await click('انتشار',true);await click('تأیید انتشار',true);await pause(700);
  check('CMS Journal explicit publication is visible through the public API',(await adminApi(`/public/editorial/journal-${suffix}`)).body.body==='متن مستقل مجله');
  await close();page.off('request',intercept);await page.setRequestInterception(false);
  await click('اجزای سایت');await wait('عنوان لوگو');await field('عنوان لوگو','کلبه آزمون');await click('ذخیره و اعمال در سایت');await pause(700);
  check('CMS global header content is persisted and read by storefront',(await adminApi('/site/layout')).body.header.logoText==='کلبه آزمون');
  for(const width of [360,390,768,1024,1280,1440]) {
    await page.setViewport({width,height:900});await pause(100);
    for(const tab of ['مجله','اجزای سایت']) {await click(tab);await pause(400);check(`CMS ${tab} ${width}px has no document overflow`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  }
  await page.setViewport({width:1440,height:1100});
}
