// Real CRM UI → API → persisted-state acceptance checks on the smoke-owned stack.
export async function crmRelationshipBrowser({page,check,openTab,adminApi,shot}) {
  const wait=async(label)=>page.waitForFunction(value=>document.body.innerText.includes(value),{timeout:15000},label);
  const click=async(label)=>{
    await page.waitForFunction(value=>[...document.querySelectorAll('button')].some(b=>b.innerText.trim()===value&&!b.disabled),{timeout:15000},label);
    return page.evaluate(value=>{
    const buttons=[...document.querySelectorAll('button')].filter(b=>b.innerText.trim()===value&&!b.disabled);
    if(!buttons.length)throw new Error(`CRM button missing: ${value}`);
    buttons.at(-1).click();
    },label);
  };
  const fill=async(label,value)=>page.evaluate(({label,value})=>{
    const field=document.querySelector(`input[aria-label="${label}"],textarea[aria-label="${label}"]`);
    if(!field)throw new Error(`CRM field missing: ${label}`);
    const proto=field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(field,value);
    field.dispatchEvent(new Event('input',{bubbles:true}));
  },{label,value});
  await openTab('مشتریان (CRM)');
  await wait('جست‌وجوی سراسری CRM');
  const name=`سرنخ آزمون ${Date.now()}`;
  await click('ثبت سرنخ');
  await wait('ثبت سرنخ جدید');
  await fill('نام و نام خانوادگی / نام مخاطب',name);
  await click('ثبت سرنخ');
  await wait(name);
  await wait('ثبت تعامل');
  check('CRM lead UI opens canonical centered relationship workspace',await page.evaluate(()=>Boolean(document.querySelector('[role="dialog"][aria-label="پرونده ارتباط و پیگیری"]'))));
  await fill('عنوان پیگیری','پیگیری آزمون مرورگر');
  await fill('موعد پیگیری','۱۴۰۵/۰۸/۰۱');
  await click('ثبت پیگیری');
  await wait('پیگیری آزمون مرورگر');
  await fill('موضوع تعامل','تماس آزمون مرورگر');
  await click('ثبت تعامل');
  await wait('تماس آزمون مرورگر');
  await fill('یادداشت کوتاه…','یادداشت آزمون مرورگر');
  await click('ثبت');
  await wait('یادداشت آزمون مرورگر');
  const found=await adminApi(`/admin/crm/search?q=${encodeURIComponent(name)}`);
  const contact=found.body.items.find(row=>row.display_name===name);
  const detail=await adminApi(`/admin/crm/contacts/${contact.contact_id}/relationship`);
  check('CRM UI mutations persist in canonical tasks, interactions and notes',detail.body.tasks.some(t=>t.title==='پیگیری آزمون مرورگر')&&detail.body.interactions.some(i=>i.subject==='تماس آزمون مرورگر')&&detail.body.notes.some(n=>n.body==='یادداشت آزمون مرورگر'));
  check('CRM Jalali follow-up input persists a canonical ISO due date',detail.body.tasks.some(t=>t.title==='پیگیری آزمون مرورگر'&&t.due_at&&Number.isFinite(Date.parse(t.due_at))));
  const taskId=detail.body.tasks.find(t=>t.title==='پیگیری آزمون مرورگر').id;
  const waitTask=async(predicate)=>{
    for(let attempt=0;attempt<40;attempt++){
      const latest=await adminApi(`/admin/crm/contacts/${contact.contact_id}/relationship`);
      const task=latest.body.tasks.find(t=>t.id===taskId);
      if(predicate(task))return task;
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    throw new Error('CRM task UI transition did not persist');
  };
  const assignee=await page.evaluate(()=>{
    const select=document.querySelector('select[aria-label="تغییر مسئول پیگیری"]');
    const value=[...select.options].find(o=>o.value).value;
    select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));return value;
  });
  check('CRM task reassignment UI persists canonical authorized owner',(await waitTask(t=>t?.assigned_to===assignee)).assigned_to===assignee);
  for(const [label,status] of [['انجام شد','done'],['بازگشایی','open'],['لغو','cancelled'],['بازگشایی','open']]){
    await click(label);
    await waitTask(t=>t?.status===status);
  }
  check('CRM task UI completes, reopens and cancels without losing follow-up',true);
  for(const width of [360,390,768,1024,1280,1440]) {
    await page.setViewport({width,height:1000});
    const metrics=await page.evaluate(()=>{
      const dialogs=[...document.querySelectorAll('[role="dialog"][aria-modal="true"]')];
      const dialog=dialogs.at(-1);const box=dialog.getBoundingClientRect();
      const formButton=[...dialog.querySelectorAll('button')].find(b=>b.innerText==='ثبت تعامل');
      return {document:document.documentElement.scrollWidth,left:box.left,right:box.right,formButton:!!formButton};
    });
    check(`CRM relationship workspace responsive ${width}px`,metrics.document<=width+1&&metrics.left>=-1&&metrics.right<=width+1&&metrics.formButton,JSON.stringify(metrics));
    if(width===390)await shot('crm-relationship-mobile');
  }
  const body=await page.evaluate(()=>document.querySelector('[role="dialog"]')?.innerText??'');
  check('CRM relationship workspace hides technical identity and enum values',!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(body)&&!/(successful|no_answer|lifecycle_stage|owner_user_id)/.test(body));
  await page.keyboard.press('Escape');
  check('CRM relationship workspace closes on Escape',await page.evaluate(()=>!document.querySelector('[role="dialog"][aria-label="پرونده ارتباط و پیگیری"]')));
  await page.setViewport({width:1440,height:1100});
  // Seeded entity workspaces use the same CRM composer and retain their own read context.
  await click('مخاطبان');
  for(const entry of [
    {tab:'مشتریان خرده',button:'پروفایل ۳۶۰°',title:'پروفایل ۳۶۰°',context:'تعداد خرید'},
    {tab:'خریداران VIP',button:'نمای ۳۶۰°',title:'نمای ۳۶۰ درجه خریدار VIP',context:'حساب و عضویت'},
    {tab:'تأمین‌کنندگان',button:'پرونده ۳۶۰°',title:'پرونده CRM تأمین‌کننده',context:'خلاصه عملکرد'},
  ]) {
    await click(entry.tab);
    await page.waitForFunction(label=>[...document.querySelectorAll('button')].some(b=>b.innerText.trim()===label),{timeout:20000},entry.button);
    await click(entry.button);
    await page.waitForFunction(context=>[...document.querySelectorAll('[role="dialog"]')].some(d=>d.innerText.includes(context)),{timeout:20000},entry.context);
    const snapshot=await page.evaluate(context=>[...document.querySelectorAll('[role="dialog"]')].find(d=>d.innerText.includes(context))?.innerText??'',entry.context);
    check(`CRM ${entry.tab} 360 displays real entity context in centered workspace`,snapshot.includes(entry.context));
    await shot(`crm-360-${entry.tab}`);
    if(entry.tab==='خریداران VIP')check('VIP CRM exposes no membership payment/refund/suspension mutations',await page.evaluate(()=>![...document.querySelectorAll('[role="dialog"] button')].some(b=>/(تغییر پلن|بازپرداخت عضویت|تعلیق عضویت|اعتبار خرید)/.test(b.innerText))));
    if(entry.tab==='تأمین‌کنندگان')check('Supplier CRM hides operations and technical audit dumps',!/(ثبت رسید|تصمیم QC|ثبت تسویه|supplier\.|owner_user_id|"old_value")/.test(snapshot));
    await click(entry.tab==='تأمین‌کنندگان'?'تعاملات، یادداشت‌ها و پیگیری‌ها':'تعاملات و پیگیری‌ها');
    await wait('ثبت تعامل');
    check(`CRM ${entry.tab} 360 opens the shared relationship composer`,await page.evaluate(()=>Boolean(document.querySelector('[role="dialog"][aria-label="پرونده ارتباط و پیگیری"]'))));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  const segment=await adminApi('/admin/crm/segments','POST',{code:`browser_${Date.now()}`,title:'گروه آزمون مرورگر',kind:'dynamic',definition:{matchMode:'all',conditions:[{field:'order_count',op:'>=',value:0}]}});
  await adminApi(`/admin/crm/segments/${segment.body.id}/refresh`,'POST');
  await click('بازاریابی');
  await wait('برچسب‌های سیستم');
  await click('سگمنت‌ها');
  await wait('گروه آزمون مرورگر');
  await page.evaluate(()=>{
    const title=[...document.querySelectorAll('p')].find(p=>p.innerText==='گروه آزمون مرورگر');
    const button=[...title.parentElement.querySelectorAll('button')].find(b=>b.innerText==='مشاهده اعضا');button.click();
  });
  await wait('اعضای گروه: گروه آزمون مرورگر');
  check('segment members open a real workspace with Persian membership evidence',await page.evaluate(()=>{
    const body=[...document.querySelectorAll('[role="dialog"]')].at(-1)?.innerText??'';
    return body.includes('دلیل حضور در گروه')&&body.includes('تعداد خرید بیشتر یا مساوی')&&!body.includes('order_count');
  }));
  await page.keyboard.press('Escape');
}
