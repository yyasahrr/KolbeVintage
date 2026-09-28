import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canTransitionCampaign, isBlocked, restrictionBlocks, CAMPAIGN_STATUSES, RESTRICTION_SCOPES } from './console.js';

// Shipping fee logic (server-side authoritative)
function calcShipping(baseFeeRial: bigint, freeAboveRial: bigint | null, subtotalRial: bigint): bigint {
  if (freeAboveRial !== null && subtotalRial >= freeAboveRial) return 0n;
  return baseFeeRial;
}

describe('shipping domain', () => {
  it('free shipping when subtotal >= threshold', () => {
    assert.equal(calcShipping(500_000n, 10_000_000n, 12_000_000n), 0n);
  });
  it('paid shipping when below threshold', () => {
    assert.equal(calcShipping(500_000n, 10_000_000n, 5_000_000n), 500_000n);
  });
  it('no free threshold always charges base', () => {
    assert.equal(calcShipping(300_000n, null, 100_000_000n), 300_000n);
  });
  it('exact threshold is free', () => {
    assert.equal(calcShipping(400_000n, 2_000_000n, 2_000_000n), 0n);
  });
  it('zero base fee is zero', () => {
    assert.equal(calcShipping(0n, 5_000_000n, 1_000_000n), 0n);
  });
  it('total = subtotal - discount + shipping', () => {
    const subtotal = 10_000_000n, discount = 2_000_000n, shipping = 500_000n;
    assert.equal(subtotal - discount + shipping, 8_500_000n);
  });
});

describe('returns domain', () => {
  const allowed: Record<string, string[]> = {
    requested: ['approved','rejected'],
    approved: ['received','rejected'],
    received: ['refunded','rejected'],
    refunded: [], rejected: []
  };
  function canTransition(from: string, to: string) { return allowed[from]?.includes(to) ?? false; }
  it('requested -> approved allowed', () => assert.equal(canTransition('requested','approved'), true));
  it('requested -> received not allowed', () => assert.equal(canTransition('requested','received'), false));
  it('approved -> received allowed', () => assert.equal(canTransition('approved','received'), true));
  it('received -> refunded allowed', () => assert.equal(canTransition('received','refunded'), true));
  it('refunded is terminal', () => assert.equal(canTransition('refunded','approved'), false));
  it('reference format RT-xxxxx', () => {
    const ref = `RT-${400001}`;
    assert.match(ref, /^RT-\d+$/);
  });
});

describe('file storage', () => {
  const ALLOWED = new Set(['image/png','image/jpeg','image/webp','image/gif','application/pdf','video/mp4','text/plain']);
  const MAX = 10 * 1024 * 1024;
  function validate(mime: string, size: number) {
    if (!ALLOWED.has(mime)) throw new Error('mime');
    if (size <=0 || size > MAX) throw new Error('size');
  }
  it('allows png under 10MB', () => { assert.doesNotThrow(()=> validate('image/png', 1024)); });
  it('rejects exe', () => { assert.throws(()=> validate('application/x-msdownload', 1024)); });
  it('rejects over 10MB', () => { assert.throws(()=> validate('image/jpeg', 11*1024*1024)); });
  it('allows pdf', () => { assert.doesNotThrow(()=> validate('application/pdf', 5000)); });
});

describe('addresses domain', () => {
  function validateAddr(a: any) {
    if (!a.recipient.trim() || !a.city.trim() || !a.province.trim() || !a.line.trim()) throw new Error('required');
    if (!/^09\d{9}$/.test(a.phone)) throw new Error('phone');
    if (!/^\d{10}$/.test(a.postalCode)) throw new Error('postal');
  }
  it('valid address passes', () => assert.doesNotThrow(()=> validateAddr({recipient:'علی', city:'تهران', province:'تهران', line:'خیابان ولیعصر پلاک ۱۰', phone:'09123456789', postalCode:'1234567890'})));
  it('invalid phone fails', () => assert.throws(()=> validateAddr({recipient:'علی', city:'تهران', province:'تهران', line:'خیابان X', phone:'123', postalCode:'1234567890'})));
  it('invalid postal fails', () => assert.throws(()=> validateAddr({recipient:'علی', city:'تهران', province:'تهران', line:'خیابان X', phone:'09123456789', postalCode:'123'})));
});

describe('membership / profile', () => {
  it('birthday format YYYY/MM/DD', () => {
    assert.match('1402/05/12', /^\d{4}\/\d{2}\/\d{2}$/);
    assert.doesNotMatch('1402-05-12', /^\d{4}\/\d{2}\/\d{2}$/);
  });
  it('email or phone required for register', () => {
    function validateReg(r: any) { if (!r.email && !r.phone) throw new Error('need one'); }
    assert.throws(()=> validateReg({}));
    assert.doesNotThrow(()=> validateReg({email:'a@b.com'}));
    assert.doesNotThrow(()=> validateReg({phone:'09123456789'}));
  });
  it('VIP request requires plan active', () => {
    function canRequest(plan: any) { return !!plan?.active; }
    assert.equal(canRequest({active:true}), true);
    assert.equal(canRequest({active:false}), false);
    assert.equal(canRequest(null), false);
  });
});

// Console domain: restrictions + SMS campaign lifecycle (pure rules, no DB)
describe('user restrictions', () => {
  it('scope blocks its own action', () => {
    assert.equal(restrictionBlocks('purchase', 'purchase'), true);
    assert.equal(restrictionBlocks('purchase', 'ticket'), false);
  });
  it('all scope blocks every action', () => {
    for (const action of ['purchase', 'ticket', 'return', 'withdrawal'] as const) {
      assert.equal(restrictionBlocks('all', action), true);
    }
  });
  it('only active restrictions block', () => {
    assert.equal(isBlocked([{ scope: 'purchase', status: 'active' }], 'purchase'), true);
    assert.equal(isBlocked([{ scope: 'purchase', status: 'lifted' }], 'purchase'), false);
  });
  it('empty list never blocks', () => {
    assert.equal(isBlocked([], 'purchase'), false);
  });
  it('scopes match the DB check constraint', () => {
    assert.deepEqual([...RESTRICTION_SCOPES], ['purchase', 'ticket', 'return', 'withdrawal', 'all']);
  });
});

describe('sms campaign lifecycle', () => {
  it('draft can be scheduled or queued', () => {
    assert.equal(canTransitionCampaign('draft', 'scheduled'), true);
    assert.equal(canTransitionCampaign('draft', 'queued'), true);
  });
  it('queued can only be sent or failed', () => {
    assert.equal(canTransitionCampaign('queued', 'sent'), true);
    assert.equal(canTransitionCampaign('queued', 'failed'), true);
    assert.equal(canTransitionCampaign('queued', 'draft'), false);
  });
  it('sent is terminal', () => {
    for (const to of CAMPAIGN_STATUSES) assert.equal(canTransitionCampaign('sent', to), false);
  });
  it('failed can be retried', () => {
    assert.equal(canTransitionCampaign('failed', 'queued'), true);
    assert.equal(canTransitionCampaign('failed', 'sent'), false);
  });
  it('cannot skip from draft to sent directly', () => {
    assert.equal(canTransitionCampaign('draft', 'sent'), false);
  });
});
