/**
 * Persian (Jalali) calendar utilities — the single conversion path for the admin console.
 *
 * Rules:
 * - The API/DB always stores ISO-8601 Gregorian instants; UI never sends Jalali.
 * - Display formats Jalali with Persian digits ("۱۴۰۵/۰۷/۱۳").
 * - Every conversion (Gregorian ⇄ Jalali) lives here; no ad-hoc string building elsewhere.
 *
 * Algorithm: the classic jalaali-js div/mod arithmetic (Khayyam calendar, 33-year cycle rules),
 * which is exact for the supported range 1178–1633 Jalali (1799–2256 Gregorian).
 */

const div = (a: number, b: number) => Math.trunc(a / b);
const mod = (a: number, b: number) => a - Math.floor(a / b) * b;

const breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

type JalCal = { leap: number; gy: number; march: number };

function jalCal(jy: number): JalCal {
  const bl = breaks.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = breaks[0]!;
  if (jy < jp || jy >= breaks[bl - 1]!) throw new Error(`سال جلالی خارج از محدوده است: ${jy}`);
  let jump = 0;
  for (let i = 1; i < bl; i += 1) {
    const jm = breaks[i]!;
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function j2d(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

function d2j(jdn: number): { jy: number; jm: number; jd: number } {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  let jm: number;
  let jd: number;
  if (k >= 0) {
    if (k <= 185) {
      jm = 1 + div(k, 31);
      jd = mod(k, 31) + 1;
      return { jy, jm, jd };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  jm = 7 + div(k, 30);
  jd = mod(k, 30) + 1;
  return { jy, jm, jd };
}

function g2d(gy: number, gm: number, gd: number): number {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

export type JalaliParts = { jy: number; jm: number; jd: number };
export type GregorianParts = { gy: number; gm: number; gd: number };

export function toJalali(date: Date): JalaliParts {
  return d2j(g2d(date.getFullYear(), date.getMonth() + 1, date.getDate()));
}

export function fromJalali(parts: JalaliParts): GregorianParts {
  const g = d2g(j2d(parts.jy, parts.jm, parts.jd));
  return { gy: g.gy, gm: g.gm, gd: g.gd };
}

/** True when the Jalali year is a leap year (esfand has 30 days). */
export function isJalaliLeapYear(jy: number): boolean {
  return jalCal(jy).leap === 0;
}

export function daysInJalaliMonth(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isJalaliLeapYear(jy) ? 30 : 29;
}

export const JALALI_MONTHS = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
] as const;
export const JALALI_WEEKDAYS = ["ش", "ی", "د", "س", "چ", "پ", "ج"] as const;

const TWO = (n: number) => String(n).padStart(2, "0");
const p = (n: number | string) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

/** ۰ = شنبه … ۶ = جمعه (the Jalali week starts on Saturday). */
export function jalaliWeekday(jy: number, jm: number, jd: number): number {
  const { gy, gm, gd } = fromJalali({ jy, jm, jd });
  const day = new Date(Date.UTC(gy, gm - 1, gd)).getUTCDay(); // 0=Sunday
  return (day + 1) % 7;
}

/** Parses a stored ISO-8601 instant; throws on anything that is not a valid date. */
export function parseIso(iso: string): Date {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`تاریخ نامعتبر است: ${iso}`);
  return date;
}

/** ISO instant → «۱۴۰۵/۰۷/۱۳» (local calendar day). */
export function formatPersianDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const date = typeof iso === "string" ? parseIso(iso) : iso;
  const { jy, jm, jd } = toJalali(date);
  return p(`${jy}/${TWO(jm)}/${TWO(jd)}`);
}

/** ISO instant → «۱۴۰۵/۰۷/۱۳ - ۱۰:۳۰» (local time). */
export function formatPersianDateTime(iso: string | Date | null | undefined, withMinute = true): string {
  if (!iso) return "—";
  const date = typeof iso === "string" ? parseIso(iso) : iso;
  const { jy, jm, jd } = toJalali(date);
  const time = withMinute ? ` - ${p(TWO(date.getHours()))}:${p(TWO(date.getMinutes()))}` : "";
  return `${p(`${jy}/${TWO(jm)}/${TWO(jd)}`)}${time}`;
}

/** ISO instant → «۱۴۰۵/۰۷/۱۳ ۱۰:۳۰:۰۰» (used in audit/log tables). */
export function formatPersianDateTimeFull(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const date = typeof iso === "string" ? parseIso(iso) : iso;
  const { jy, jm, jd } = toJalali(date);
  return `${p(`${jy}/${TWO(jm)}/${TWO(jd)}`)} ${p(TWO(date.getHours()))}:${p(TWO(date.getMinutes()))}:${p(TWO(date.getSeconds()))}`;
}

/** «۱۴۰۵/۰۷/۱۳» (or «1405/07/13») → ISO instant at local 00:00. Returns null when unparsable. */
export function persianInputToIso(value: string): string | null {
  const normalized = value.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).trim();
  const match = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(normalized);
  if (!match) return null;
  const jy = Number(match[1]); const jm = Number(match[2]); const jd = Number(match[3]);
  if (jm < 1 || jm > 12 || jd < 1 || jd > daysInJalaliMonth(jy, jm)) return null;
  const { gy, gm, gd } = fromJalali({ jy, jm, jd });
  return new Date(gy, gm - 1, gd, 0, 0, 0, 0).toISOString();
}

/** ISO instant → «۱۴۰۵/۰۷/۱۳» suitable for an <input value>. */
export const isoToPersianInput = (iso: string | null | undefined): string => (iso ? formatPersianDate(iso) : "");

/** Date parts for a Jalali calendar grid, computed from a stored ISO instant. */
export function jalaliPartsFromIso(iso: string): JalaliParts {
  return toJalali(parseIso(iso));
}

/** ISO for «today» at local midnight — used as the default in pickers. */
export function todayIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** Adds calendar days to an ISO instant (Jalali-safe because it works on the Gregorian instant). */
export function addDaysIso(iso: string, days: number): string {
  const date = parseIso(iso);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

/** Jalali parts of an ISO instant shifted by `days`, for the picker's quick ranges. */
export function shiftJalaliDays(iso: string, days: number): string {
  return addDaysIso(iso, days);
}
