/**
 * Canonical Frontend ↔ Backend contracts — single source of truth for payload
 * shapes, status vocabularies and response adapters.
 *
 * This module is intentionally PURE (no React, no window, no import.meta.env) so
 * the same builders run in the browser and inside the Node contract tests:
 *   - `backend/src/contracts.test.ts`
 *   - `backend/scripts/frontend-contract-smoke.ts`
 *
 * Backend truth lives in `backend/src/tickets.ts`, `backend/src/catalog.ts`,
 * `backend/src/files.ts`. Any change there must be mirrored here.
 */

export class ContractError extends Error {}

/* ============================== Tickets ============================== */

/** Backend `tickets.status` enum (backend/src/tickets.ts statusBody). */
export const TICKET_STATUSES = ["new", "reviewing", "waiting_user", "answered", "escalated", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Translation lives ONLY here (UI labels) — never in business logic. */
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  new: "جدید",
  reviewing: "در حال بررسی",
  waiting_user: "منتظر کاربر",
  answered: "پاسخ داده شد",
  escalated: "ارجاع شده",
  resolved: "حل شده",
  closed: "بسته شد",
};

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: "کم", normal: "عادی", high: "فوری", urgent: "بحرانی",
};

export const TICKET_CATEGORIES = [
  "پیگیری سفارش", "مرجوعی و بازگشت", "پرداخت و مالی", "عضویت عمده", "محصول و موجودی", "مالی و تسویه", "سایر موارد",
] as const;

export const TICKET_DEPARTMENTS = [
  "پشتیبانی عمومی", "سفارش و ارسال", "مالی و تسویه", "محصول و انبار", "همکاری تأمین‌کنندگان",
] as const;

export const isTicketStatus = (value: unknown): value is TicketStatus =>
  typeof value === "string" && (TICKET_STATUSES as readonly string[]).includes(value);
export const isTicketPriority = (value: unknown): value is TicketPriority =>
  typeof value === "string" && (TICKET_PRIORITIES as readonly string[]).includes(value);

/** POST /tickets body — exactly what the backend parses. */
export type TicketCreate = {
  subject: string;
  category: string;
  priority: TicketPriority;
  orderId?: string;
  message: string;
};

export function buildTicketCreatePayload(input: {
  subject: string;
  category?: string;
  priority?: string;
  orderId?: string | null;
  message: string;
}): TicketCreate {
  const subject = input.subject.trim();
  const message = input.message.trim();
  const category = (input.category ?? TICKET_CATEGORIES[0]).trim();
  const priority: TicketPriority = isTicketPriority(input.priority) ? input.priority : "normal";
  if (subject.length < 3) throw new ContractError("موضوع تیکت باید دست‌کم ۳ نویسه باشد.");
  if (category.length < 2) throw new ContractError("دسته تیکت را انتخاب کنید.");
  if (message.length < 8) throw new ContractError("متن تیکت باید دست‌کم ۸ نویسه باشد.");
  const orderId = input.orderId?.trim() || undefined;
  if (orderId) assertUuid(orderId, "شناسه سفارش تیکت باید UUID واقعی سفارش باشد؛ شماره نمایشی سفارش را نفرستید.");
  return { subject, category, priority, ...(orderId ? { orderId } : {}), message };
}

/** POST /tickets/:id/messages body. */
export type TicketReply = { message: string; internal: boolean };

export function buildTicketReplyPayload(message: string, internal = false): TicketReply {
  const body = message.trim();
  if (!body) throw new ContractError("متن پاسخ خالی است.");
  if (body.length > 10000) throw new ContractError("متن پاسخ بیش از حد مجاز است.");
  return { message: body, internal };
}

/** PATCH /tickets/:id body. `assigneeId` is a real user UUID (null clears it). */
export type TicketUpdate = { status: TicketStatus; department?: string; assigneeId?: string | null };

export function buildTicketUpdatePayload(patch: {
  status: TicketStatus;
  department?: string | null;
  assigneeId?: string | null;
}): TicketUpdate {
  if (!isTicketStatus(patch.status)) throw new ContractError("وضعیت تیکت معتبر نیست.");
  const department = patch.department?.trim() || undefined;
  const payload: TicketUpdate = { status: patch.status };
  if (department) payload.department = department;
  if (patch.assigneeId !== undefined) {
    const assigneeId = patch.assigneeId?.trim() || null;
    if (assigneeId) assertUuid(assigneeId, "کارشناس انتخاب‌شده باید شناسه کاربر واقعی باشد.");
    payload.assigneeId = assigneeId;
  }
  return payload;
}

export type TicketMessage = { id: string; senderId: string | null; internal: boolean; body: string; createdAt: string };

/** Normalized attachment (GET /tickets/:id and POST /tickets/:id/attachments). */
export type TicketAttachment = {
  id: string;
  ticketId: string | null;
  fileId: string | null;
  title: string;
  mime: string;
  size: number;
  createdAt: string;
  /** Server download path (`GET /files/:id`) — never a data URL in real runtime. */
  url: string | null;
};

export type Ticket = {
  id: string;
  reference: string;
  ownerId: string;
  status: TicketStatus;
  priority: TicketPriority;
  subject: string;
  category: string;
  department: string | null;
  assigneeId: string | null;
  orderId: string | null;
  slaDueAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  messages: TicketMessage[];
  attachments: TicketAttachment[];
};

export const fileDownloadPath = (fileId: string) => `/api/v1/files/${fileId}`;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
}
function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeTicketAttachment(raw: unknown): TicketAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const fileMeta = (row.fileMeta ?? row.file_meta ?? {}) as Record<string, unknown>;
  const fileId = asNullableString(row.fileId ?? row.file_id) ?? asNullableString(fileMeta.fileId);
  const id = asNullableString(row.id) ?? asNullableString(fileMeta.url) ?? fileId;
  if (!id) return null;
  const url = fileId ? fileDownloadPath(fileId) : asNullableString(fileMeta.url);
  return {
    id,
    ticketId: asNullableString(row.ticketId ?? row.ticket_id),
    fileId,
    title: asString(row.title ?? fileMeta.originalName, "پیوست"),
    mime: asString(row.mime ?? fileMeta.mime ?? fileMeta.type, "application/octet-stream"),
    size: Number(row.size ?? fileMeta.size ?? 0) || 0,
    createdAt: asString(row.createdAt ?? row.created_at, ""),
    url,
  };
}

export function normalizeTicket(raw: unknown): Ticket | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) return null;
  const rawStatus = row.status;
  const rawMessages = Array.isArray(row.messages) ? (row.messages as unknown[]) : [];
  const rawAttachments = Array.isArray(row.attachments) ? (row.attachments as unknown[]) : [];
  const fallbackMessage = asNullableString(row.description);
  return {
    id,
    reference: asString(row.reference ?? row.id),
    ownerId: asString(row.ownerId ?? row.owner_id),
    status: isTicketStatus(rawStatus) ? rawStatus : "new",
    priority: isTicketPriority(row.priority) ? row.priority : "normal",
    subject: asString(row.subject ?? row.title),
    category: asString(row.category),
    department: asNullableString(row.department),
    assigneeId: asNullableString(row.assigneeId ?? row.assignee_id),
    orderId: asNullableString(row.orderId ?? row.order_id),
    slaDueAt: asNullableString(row.slaDueAt ?? row.sla_due_at),
    createdAt: asString(row.createdAt ?? row.created_at),
    updatedAt: asNullableString(row.updatedAt ?? row.updated_at),
    messages: rawMessages.length
      ? rawMessages.map((message): TicketMessage => {
          const item = (message ?? {}) as Record<string, unknown>;
          return {
            id: asString(item.id ?? item.createdAt ?? item.created_at),
            senderId: asNullableString(item.senderId ?? item.sender_id),
            internal: item.internal === true,
            body: asString(item.body ?? item.message ?? item.text),
            createdAt: asString(item.createdAt ?? item.created_at),
          };
        })
      : fallbackMessage
        ? [{ id: `${id}-initial`, senderId: null, internal: false, body: fallbackMessage, createdAt: asString(row.createdAt ?? row.created_at) }]
        : [],
    attachments: rawAttachments.map(normalizeTicketAttachment).filter((item): item is TicketAttachment => item !== null),
  };
}

export type TicketBoard = Record<TicketStatus, Ticket[]>;

export const emptyTicketBoard = (): TicketBoard =>
  Object.fromEntries(TICKET_STATUSES.map((status) => [status, [] as Ticket[]])) as TicketBoard;

/**
 * GET /tickets/board returns `{ columns: { new: [], reviewing: [], … } }`.
 * Admin Kanban consumes `columns` directly — no `items`/`tickets` guessing.
 */
export function adaptTicketBoard(raw: unknown): TicketBoard {
  const board = emptyTicketBoard();
  const source = (raw ?? {}) as Record<string, unknown>;
  const columns = (source.columns ?? source) as Record<string, unknown>;
  for (const status of TICKET_STATUSES) {
    const bucket = Array.isArray(columns[status]) ? (columns[status] as unknown[]) : [];
    board[status] = bucket.map(normalizeTicket).filter((ticket): ticket is Ticket => ticket !== null);
  }
  return board;
}

/** GET /tickets returns `{ items: […] }`; board endpoint returns `{ columns }`. */
export function adaptTicketList(raw: unknown): Ticket[] {
  const source = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(raw) ? (raw as unknown[])
    : Array.isArray(source.items) ? (source.items as unknown[])
      : Array.isArray(source.tickets) ? (source.tickets as unknown[])
        : [];
  return rows.map(normalizeTicket).filter((ticket): ticket is Ticket => ticket !== null);
}

/* ============================== Products ============================== */

/* ====================== Commerce structure (items 1-10, 35-52, 82-84, 122-135, 245-247) ====================== */

/** POST /products variant input. `weightGrams` is per-variant (item 49/83); omitted when unknown. */
export type ProductVariantInput = { size?: string; color?: string; weightGrams?: number | null; attributes: Record<string, string> };

/**
 * Colors × sizes → real variants. The client NEVER builds SKUs: the backend
 * generates `KV-<CATEGORY>-<sequence>` / `SP-…` per variant.
 */
export function buildProductVariants(colors: string[], sizes: string[], variantWeights?: Record<string, string | number>): ProductVariantInput[] {
  const cleanColors = colors.map((color) => color.trim()).filter(Boolean);
  const cleanSizes = sizes.map((size) => size.trim()).filter(Boolean);
  if (!cleanColors.length) throw new ContractError("دست‌کم یک رنگ محصول لازم است.");
  if (!cleanSizes.length) throw new ContractError("دست‌کم یک سایز محصول لازم است.");
  const variants: ProductVariantInput[] = [];
  for (const color of cleanColors) {
    for (const size of cleanSizes) {
      const variant: ProductVariantInput = { size, color, attributes: {} };
      const weight = variantWeights?.[`${color}|${size}`];
      if (weight !== undefined && weight !== null && String(weight).trim() !== "") {
        const grams = Math.floor(Number(String(weight).replace(/[^\d]/g, "")));
        if (!Number.isFinite(grams) || grams < 0) throw new ContractError(`وزن واریانت ${color}/${size} معتبر نیست.`);
        variant.weightGrams = grams;
      }
      variants.push(variant);
    }
  }
  return variants;
}

/** Metadata bucket for fields that have no dedicated column yet (schema is explicit). */
export type ProductMetadata = {
  images: { fileId: string | null; url: string }[];
  videoFileId: string | null;
  fabric: string;
  care: string;
  seo: { title: string; slug: string };
  cutout: { status: string; src?: string; source?: string; note?: string } | null;
  channels: { retail: boolean; wholesale: boolean; styleBuilder: boolean };
  /** Stock and all pricing/promotion state are stored in their owning WMS/catalog domains, never here. */
  editorialSku: string | null;
};

export const INSTALLMENT_POLICIES = ["enabled", "disabled", "disabled_when_discounted", "enabled_when_discounted"] as const;
export type InstallmentPolicy = (typeof INSTALLMENT_POLICIES)[number];
export const INSTALLMENT_POLICY_LABEL: Record<InstallmentPolicy, string> = {
  enabled: "قسط فعال",
  disabled: "بدون قسط",
  disabled_when_discounted: "قسط فقط بدون تخفیف",
  enabled_when_discounted: "قسط حتی با تخفیف",
};

export type ProductCreate = {
  brand: string;
  name: string;
  category: string;
  description: string;
  cashPriceRial: string;
  installmentPriceRial?: string;
  wholesalePriceRial?: string;
  variants: ProductVariantInput[];
  metadata: ProductMetadata;
  /** Item 8/35/36/46/245-247 — all optional; the server applies ownership/channel defaults. */
  productTypeId?: string;
  retailEnabled?: boolean;
  wholesaleEnabled?: boolean;
  installmentPolicy?: InstallmentPolicy;
  wholesaleMoq?: number;
  genderCode?: string;
  seasons?: string[];
};

export type ProductMediaRef = { fileId: string | null; url: string };
export type ProductSeriesDraft = {
  name: string; pieces: number; moqSeries: number; pricePerSeries: number; available: boolean; colorIds?: string[];
};
export type ProductStudioDraft = {
  name: string;
  brand: string;
  category: string;
  description?: string;
  editorialSku?: string;
  retailOn: boolean;
  wholesaleOn: boolean;
  cashToman?: string;
  installmentToman?: string;
  colors: { name: string }[];
  sizes: string[];
  images: ProductMediaRef[];
  videoFileId?: string | null;
  fabric?: string;
  care?: string;
  seoTitle?: string;
  slug?: string;
  cutout?: { status: string; src?: string; source?: string; note?: string } | null;
  series?: ProductSeriesDraft[];
  /** Initial stock is NOT part of the product payload — it is received through WMS after create. */
  productTypeId?: string;
  genderCode?: string;
  seasons?: string[];
  installmentPolicy?: InstallmentPolicy;
  wholesaleMoq?: string;
  /** Per-variant weight in grams, keyed by `${color}|${size}` (same key as `variantKey`). */
  variantWeights?: Record<string, string>;
};

/** Toman (UI) → Rial (server). Integer strings only; the backend regex is /^\\d+$/. */
export function rialFromToman(value: string | number | undefined | null): string {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  if (!digits) return "0";
  return (BigInt(digits) * 10n).toString();
}

/** Rial (server) → Toman (UI). Tolerates negative balances; returns 0 for junk. */
export function tomanFromRial(value: unknown): number {
  const digits = String(value ?? "").replace(/[^\d-]/g, "");
  if (!digits || digits === "-") return 0;
  try {
    return Number(BigInt(digits) / 10n);
  } catch {
    return 0;
  }
}

const groupPersian = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, "\u066c")
  .replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);

const splitSign = (value: unknown) => {
  const digits = String(value ?? "").replace(/[^\d-]/g, "");
  if (!digits || digits === "-") return null;
  const negative = digits.startsWith("-");
  return { negative, raw: negative ? digits.slice(1) : digits };
};

/**
 * Rial amount → grouped Persian Rial label, no conversion («۱٬۲۳۴٬۵۶۷ ریال»).
 * Use for values that must stay in Rial (ledger columns, journal exports).
 */
export function fmtRial(value: unknown): string {
  const parts = splitSign(value);
  if (!parts) return "—";
  return `${parts.negative ? "−" : ""}${groupPersian(parts.raw)} ریال`;
}

/**
 * Rial amount (server unit) → grouped Persian Toman for money cells, which is the
 * unit the console shows everywhere else. The remainder is kept as one decimal so a
 * 5-Rial figure can never be rounded away silently.
 */
export function fmtToman(value: unknown): string {
  const parts = splitSign(value);
  if (!parts) return "—";
  const rial = BigInt(parts.raw);
  const toman = rial / 10n;
  const remainder = rial % 10n;
  const label = groupPersian(toman.toString()) + (remainder === 0n ? "" : `٫${groupPersian(remainder.toString())}`);
  return `${parts.negative ? "−" : ""}${label} تومان`;
}

export function buildProductCreatePayload(draft: ProductStudioDraft): ProductCreate {
  const name = draft.name.trim();
  const brand = draft.brand.trim();
  const category = draft.category.trim();
  if (name.length < 2) throw new ContractError("نام محصول باید دست‌کم ۲ نویسه باشد.");
  if (!brand) throw new ContractError("برند محصول لازم است.");
  if (!category) throw new ContractError("دسته محصول لازم است.");
  if (!draft.retailOn && !draft.wholesaleOn) throw new ContractError("دست‌کم یک کانال فروش لازم است.");
  if (!draft.images.length) throw new ContractError("دست‌کم یک تصویر محصول لازم است.");

  const offered = (draft.series ?? []).filter((series) => series.available && series.pricePerSeries > 0);
  const wholesaleRial = draft.wholesaleOn && offered.length
      ? rialFromToman(Math.min(...offered.map((series) => series.pricePerSeries)))
    : undefined;
  const cashRial = draft.retailOn ? rialFromToman(draft.cashToman) : "0";
  const installmentRial = draft.retailOn
    ? rialFromToman(draft.installmentToman && draft.installmentToman !== "" ? draft.installmentToman : draft.cashToman)
    : undefined;

  if (BigInt(cashRial) === 0n && (!wholesaleRial || BigInt(wholesaleRial) === 0n)) {
    throw new ContractError("دست‌کم یک قیمت معتبر (خرده یا عمده) لازم است.");
  }

  const variants = buildProductVariants(draft.colors.map((color) => color.name), draft.sizes, draft.variantWeights);
  const moq = draft.wholesaleMoq !== undefined && draft.wholesaleMoq !== "" ? Math.floor(Number(draft.wholesaleMoq)) : null;
  if (moq !== null && (!Number.isInteger(moq) || moq < 0)) throw new ContractError("حداقل سفارش عمده باید عدد نامنفی باشد.");

  const metadata: ProductMetadata = {
    images: draft.images.map((image) => ({ fileId: image.fileId, url: image.url })),
    videoFileId: draft.videoFileId ?? null,
    fabric: draft.fabric?.trim() ?? "",
    care: draft.care?.trim() ?? "",
    seo: { title: draft.seoTitle?.trim() || name, slug: draft.slug?.trim() || "" },
    cutout: draft.cutout && draft.cutout.status !== "none" ? draft.cutout : null,
    channels: { retail: draft.retailOn, wholesale: draft.wholesaleOn, styleBuilder: draft.cutout?.status === "ready" },
    editorialSku: draft.editorialSku?.trim() || null,
  };

  const genderCode = draft.genderCode?.trim() || undefined;
  const seasons = (draft.seasons ?? []).map((season) => season.trim()).filter(Boolean);
  return {
    brand, name, category,
    description: draft.description?.trim() ?? "",
    cashPriceRial: cashRial,
    ...(installmentRial ? { installmentPriceRial: installmentRial } : {}),
    ...(wholesaleRial ? { wholesalePriceRial: wholesaleRial } : {}),
    ...(draft.productTypeId ? { productTypeId: draft.productTypeId } : {}),
    // Channels default to both-on; only explicit opt-outs travel over the wire.
    ...(!draft.retailOn ? { retailEnabled: false } : {}),
    ...(!draft.wholesaleOn ? { wholesaleEnabled: false } : {}),
    ...(draft.installmentPolicy && draft.installmentPolicy !== "enabled" ? { installmentPolicy: draft.installmentPolicy } : {}),
    ...(moq !== null && moq > 0 ? { wholesaleMoq: moq } : {}),
    ...(genderCode ? { genderCode } : {}),
    ...(seasons.length ? { seasons } : {}),
    variants,
    metadata,
  };
}

/** Stable key for a (color, size) variant cell in the inventory table. */
export const variantKey = (color: string | null | undefined, size: string | null | undefined) => `${color ?? "-"}|${size ?? "-"}`;

/** colors × sizes matrix in a stable order (matches `buildProductVariants`). */
export function variantMatrix(colors: string[], sizes: string[]): { color: string; size: string }[] {
  return colors.flatMap((color) => sizes.map((size) => ({ color, size })));
}

/** POST /products response — SKUs come from `variants`, never from a top-level `sku`. */
export type ProductVariantCreated = { id: string; sku: string; color?: string | null; size?: string | null; attributes?: Record<string, string> };
export type ProductCreateResponse = { id: string; status: string; variants: ProductVariantCreated[] };

export function readProductCreateResponse(raw: unknown): ProductCreateResponse {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) throw new ContractError("پاسخ سرور برای ایجاد محصول شناسه ندارد.");
  const variants = (Array.isArray(row.variants) ? (row.variants as unknown[]) : []).map((variant) => {
    const item = (variant ?? {}) as Record<string, unknown>;
    const attributes = (item.attributes ?? {}) as Record<string, string>;
    return {
      id: asString(item.id), sku: asString(item.sku),
      color: asNullableString(item.color ?? item.color_label ?? attributes.color),
      size: asNullableString(item.size ?? item.size_label ?? attributes.size),
      attributes,
    };
  });
  return { id, status: asString(row.status, "draft"), variants };
}

export function productVariantSkus(response: ProductCreateResponse): string[] {
  return response.variants.map((variant) => variant.sku).filter(Boolean);
}

/* ============================== Files ============================== */

/** POST /files response (backend/src/files.ts). */
export type FileUploadResponse = { id: string; storageKey: string; originalName: string; mime: string; size: number; sha256: string };

export function readFileUploadResponse(raw: unknown): FileUploadResponse {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) throw new ContractError("پاسخ سرور برای بارگذاری فایل شناسه ندارد.");
  return {
    id,
    storageKey: asString(row.storageKey ?? row.storage_key),
    originalName: asString(row.originalName ?? row.original_name, "file"),
    mime: asString(row.mime ?? row.mimeType ?? row.mime_type, "application/octet-stream"),
    size: Number(row.size ?? row.sizeBytes ?? row.size_bytes ?? 0) || 0,
    sha256: asString(row.sha256),
  };
}

/* ============================== helpers ============================== */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean { return UUID_RE.test(value); }
function assertUuid(value: string, message: string): void {
  if (!isUuid(value)) throw new ContractError(message);
}

/* ============================== Shipping ============================== */

/** Backend `shipping_methods.type` enum (backend/src/shipping.ts). Values stay English; only labels translate. */
export const SHIPPING_TYPES = ["standard", "express", "free", "pickup"] as const;
export type ShippingType = (typeof SHIPPING_TYPES)[number];
export const SHIPPING_TYPE_LABEL: Record<ShippingType, string> = {
  standard: "استاندارد", express: "سریع", free: "رایگان", pickup: "تحویل حضوری",
};
export const isShippingType = (value: unknown): value is ShippingType =>
  typeof value === "string" && (SHIPPING_TYPES as readonly string[]).includes(value);

export const SHIPPING_PRICING_TYPES = ["flat", "weight", "free", "order_value", "destination", "carrier"] as const;
export type ShippingPricingType = (typeof SHIPPING_PRICING_TYPES)[number];
export const SHIPPING_PRICING_TYPE_LABEL: Record<ShippingPricingType, string> = {
  flat: "مبلغ ثابت", weight: "پلکانی وزنی", free: "رایگان",
  order_value: "بر اساس مبلغ سفارش", destination: "بر اساس مقصد", carrier: "نرخ حامل (API)",
};
export const isShippingPricingType = (value: unknown): value is ShippingPricingType =>
  typeof value === "string" && (SHIPPING_PRICING_TYPES as readonly string[]).includes(value);

export const SHIPPING_RULE_TYPES = ["flat", "weight", "free", "order_value", "destination"] as const;
export type ShippingRuleType = (typeof SHIPPING_RULE_TYPES)[number];
export const SHIPPING_RULE_TYPE_LABEL: Record<ShippingRuleType, string> = {
  flat: "ثابت", weight: "وزنی", free: "رایگان", order_value: "مبلغ سفارش", destination: "مقصد",
};

/** Exactly the wire shape of a shipping price rule (backend serializer). */
export type ShippingPriceRule = {
  id: string; methodId: string; ruleType: ShippingRuleType;
  minWeightGrams: number | null; maxWeightGrams: number | null;
  minOrderRial: string | null; maxOrderRial: string | null;
  province: string | null; city: string | null; feeRial: string;
  position: number; active: boolean;
};

export function normalizeShippingPriceRule(raw: unknown): ShippingPriceRule | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) return null;
  const ruleType = typeof row.ruleType === "string" && (SHIPPING_RULE_TYPES as readonly string[]).includes(row.ruleType)
    ? (row.ruleType as ShippingRuleType) : "flat";
  return {
    id,
    methodId: asString(row.methodId ?? row.method_id),
    ruleType,
    minWeightGrams: (row.minWeightGrams ?? row.min_weight_grams ?? null) as number | null,
    maxWeightGrams: (row.maxWeightGrams ?? row.max_weight_grams ?? null) as number | null,
    minOrderRial: (row.minOrderRial ?? row.min_order_rial ?? null) as string | null,
    maxOrderRial: (row.maxOrderRial ?? row.max_order_rial ?? null) as string | null,
    province: asNullableString(row.province),
    city: asNullableString(row.city),
    feeRial: asString(row.feeRial ?? row.fee_rial, "0"),
    position: Number(row.position ?? 0) || 0,
    active: row.active !== false,
  };
}

/** Exactly the wire shape of GET /admin/shipping-methods (backend serializer). */
export type ShippingMethod = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  type: ShippingType;
  pricingType: ShippingPricingType;
  baseFeeRial: string;
  freeAboveRial: string | null;
  estimatedMinDays: number;
  estimatedMaxDays: number;
  config: Record<string, unknown>;
  rules: ShippingPriceRule[];
};

export function normalizeShippingMethod(raw: unknown): ShippingMethod | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) return null;
  return {
    id,
    code: asString(row.code),
    name: asString(row.name),
    active: row.active !== false,
    type: isShippingType(row.type) ? row.type : "standard",
    pricingType: isShippingPricingType(row.pricingType ?? row.pricing_type) ? (row.pricingType ?? row.pricing_type) as ShippingPricingType : "flat",
    baseFeeRial: asString(row.baseFeeRial ?? row.base_fee_rial, "0"),
    freeAboveRial: asNullableString(row.freeAboveRial ?? row.free_above_rial),
    estimatedMinDays: Number(row.estimatedMinDays ?? row.estimated_min_days ?? 0) || 0,
    estimatedMaxDays: Number(row.estimatedMaxDays ?? row.estimated_max_days ?? 0) || 0,
    config: (row.config ?? {}) as Record<string, unknown>,
    rules: (Array.isArray(row.rules) ? (row.rules as unknown[]) : [])
      .map(normalizeShippingPriceRule).filter((rule): rule is ShippingPriceRule => rule !== null),
  };
}

export const normalizeShippingMethods = (raw: unknown): ShippingMethod[] =>
  ((raw ?? {}) as { items?: unknown[] }).items?.map(normalizeShippingMethod).filter((m): m is ShippingMethod => m !== null) ?? [];

/** Building rules for a shipping method: the frontend only ever sends these keys. */
export type ShippingMethodInput = {
  code: string;
  name: string;
  type: ShippingType;
  pricingType?: ShippingPricingType;
  active: boolean;
  baseFeeRial: string;
  freeAboveRial: string | null;
  estimatedMinDays: number;
  estimatedMaxDays: number;
  config?: Record<string, unknown>;
};

/** POST /admin/shipping-methods/:id/rules input (same keys for PATCH). */
export type ShippingRuleInput = {
  ruleType: ShippingRuleType;
  minWeightGrams?: number | null;
  maxWeightGrams?: number | null;
  minOrderRial?: string | null;
  maxOrderRial?: string | null;
  province?: string | null;
  city?: string | null;
  feeRial: string;
  position?: number;
  active?: boolean;
};

export function buildShippingRulePayload(input: ShippingRuleInput): Record<string, unknown> {
  if (!/^\d+$/.test(input.feeRial)) throw new ContractError("هزینه قانون باید عدد صحیح (ریال) باشد.");
  if (input.ruleType === "weight" && input.minWeightGrams == null && input.maxWeightGrams == null) {
    throw new ContractError("قانون وزنی دست‌کم یک کران وزن لازم دارد.");
  }
  if (input.minWeightGrams != null && input.maxWeightGrams != null && input.maxWeightGrams < input.minWeightGrams) {
    throw new ContractError("سقف وزن نمی‌تواند کمتر از کف وزن باشد.");
  }
  return {
    ruleType: input.ruleType,
    ...(input.minWeightGrams != null ? { minWeightGrams: input.minWeightGrams } : {}),
    ...(input.maxWeightGrams != null ? { maxWeightGrams: input.maxWeightGrams } : {}),
    ...(input.minOrderRial ? { minOrderRial: input.minOrderRial } : {}),
    ...(input.maxOrderRial ? { maxOrderRial: input.maxOrderRial } : {}),
    ...(input.province?.trim() ? { province: input.province.trim() } : {}),
    ...(input.city?.trim() ? { city: input.city.trim() } : {}),
    feeRial: input.feeRial,
    ...(input.position !== undefined ? { position: input.position } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}),
  };
}

/** POST /shipping/quote response — the same fee checkout will charge. */
export type ShippingQuote = { methodId: string; feeRial: string; totalWeightGrams: number; ruleId: string | null; pricingType: string };
export function readShippingQuote(raw: unknown): ShippingQuote {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    methodId: asString(row.methodId),
    feeRial: asString(row.feeRial, "0"),
    totalWeightGrams: Number(row.totalWeightGrams ?? 0) || 0,
    ruleId: asNullableString(row.ruleId),
    pricingType: asString(row.pricingType, "flat"),
  };
}

export function buildShippingMethodPayload(input: ShippingMethodInput): ShippingMethodInput {
  const code = input.code.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(code)) throw new ContractError("کد روش ارسال باید با حروف انگلیسی کوچک، عدد، - یا _ و بین ۲ تا ۴۰ نویسه باشد.");
  if (input.name.trim().length < 2) throw new ContractError("نام روش ارسال باید دست‌کم ۲ نویسه باشد.");
  if (!/^\d+$/.test(input.baseFeeRial)) throw new ContractError("هزینه پایه باید عدد صحیح (ریال) باشد.");
  if (input.freeAboveRial !== null && !/^\d+$/.test(input.freeAboveRial)) throw new ContractError("سقف ارسال رایگان باید عدد صحیح (ریال) باشد.");
  if (input.estimatedMaxDays < input.estimatedMinDays) throw new ContractError("حداکثر زمان تحویل نمی‌تواند کمتر از حداقل باشد.");
  return {
    code, name: input.name.trim(), type: input.type, active: input.active,
    ...(input.pricingType && input.pricingType !== "flat" ? { pricingType: input.pricingType } : {}),
    baseFeeRial: input.baseFeeRial, freeAboveRial: input.freeAboveRial,
    estimatedMinDays: input.estimatedMinDays, estimatedMaxDays: input.estimatedMaxDays,
    config: input.config ?? {},
  };
}

/** GET/PUT /admin/site-settings/shipping. */
export type ShippingSettings = { defaultWarehouseId: string | null; freeShippingThresholdRial: string; autoTracking: boolean };

export function normalizeShippingSettings(raw: unknown): ShippingSettings {
  const row = ((raw ?? {}) as { settings?: Record<string, unknown> }).settings ?? (raw ?? {}) as Record<string, unknown>;
  return {
    defaultWarehouseId: asNullableString(row.defaultWarehouseId),
    freeShippingThresholdRial: asString(row.freeShippingThresholdRial, "0"),
    autoTracking: row.autoTracking === true,
  };
}

/* ============================== Warehouses & WMS ============================== */

export type Warehouse = { id: string; code: string; name: string; owner_id?: string | null; active?: boolean };

export const normalizeWarehouses = (raw: unknown): Warehouse[] =>
  (((raw ?? {}) as { items?: unknown[] }).items ?? []).map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return { id: asString(row.id), code: asString(row.code), name: asString(row.name), owner_id: asNullableString(row.owner_id ?? row.ownerId), active: row.active !== false };
  }).filter((warehouse) => warehouse.id !== "");

export type StockBalance = {
  variantId: string; warehouseId: string; warehouseCode: string; warehouseName: string;
  sku: string; productName: string; color: string | null; size: string | null;
  onHand: number; reserved: number; incoming: number; damaged: number; available: number;
};

export function normalizeStockBalance(raw: unknown): StockBalance {
  const row = (raw ?? {}) as Record<string, unknown>;
  const num = (key: string) => Number(row[key] ?? 0) || 0;
  return {
    variantId: asString(row.variant_id ?? row.variantId), warehouseId: asString(row.warehouse_id ?? row.warehouseId),
    warehouseCode: asString(row.warehouse_code ?? row.warehouseCode), warehouseName: asString(row.warehouse_name ?? row.warehouseName, "—"),
    sku: asString(row.sku), productName: asString(row.product_name ?? row.productName, "—"),
    color: asNullableString(row.color ?? row.color_label ?? row.colorLabel), size: asNullableString(row.size ?? row.size_label ?? row.sizeLabel),
    onHand: num("on_hand") || num("onHand"), reserved: num("reserved"), incoming: num("incoming"), damaged: num("damaged"),
    available: num("available"),
  };
}

export const normalizeStockBalances = (raw: unknown): StockBalance[] =>
  (((raw ?? {}) as { items?: unknown[] }).items ?? []).map(normalizeStockBalance);

/** Persian labels for the WMS columns — API/DB field names never change. */
export const WMS_LABEL = {
  onHand: "موجودی فیزیکی", reserved: "رزرو شده", damaged: "آسیب‌دیده", incoming: "در راه", available: "قابل فروش",
  sku: "کد کالا (SKU)", product: "محصول", warehouse: "انبار", color: "رنگ", size: "سایز", initial: "موجودی اولیه",
  movementHistory: "تاریخچه گردش", receipt: "رسید ورودی", adjustment: "اصلاح موجودی", transfer: "انتقال بین انبارها",
  from: "مبدأ", to: "مقصد", qty: "تعداد", reason: "علت", reference: "شماره مرجع", lowStock: "موجودی کم", threshold: "آستانه",
} as const;

/** GET /admin/products/:id/inventory — the product editor's read-only WMS view. */
export type ProductInventory = {
  productId: string;
  totals: { available: number; reserved: number; incoming: number; damaged: number };
  variants: { variantId: string; sku: string; color: string | null; size: string | null; available: number }[];
  items: StockBalance[];
};

export function readProductInventory(raw: unknown): ProductInventory {
  const row = (raw ?? {}) as Record<string, unknown>;
  if (!asNullableString(row.productId)) throw new ContractError("پاسخ موجودی محصول معتبر نیست.");
  const totalsRow = (row.totals ?? {}) as Record<string, unknown>;
  return {
    productId: asString(row.productId),
    totals: {
      available: Number(totalsRow.available ?? 0) || 0, reserved: Number(totalsRow.reserved ?? 0) || 0,
      incoming: Number(totalsRow.incoming ?? 0) || 0, damaged: Number(totalsRow.damaged ?? 0) || 0,
    },
    variants: (Array.isArray(row.variants) ? row.variants : []).map((item) => {
      const variant = (item ?? {}) as Record<string, unknown>;
      return { variantId: asString(variant.variant_id ?? variant.variantId), sku: asString(variant.sku),
        color: asNullableString(variant.color), size: asNullableString(variant.size), available: Number(variant.available ?? 0) || 0 };
    }),
    items: (Array.isArray(row.items) ? row.items : []).map(normalizeStockBalance),
  };
}

/* ============================== CMS ============================== */

export type CmsPage = { id: string; code: string; title: string; path: string; active: boolean; section_count: number };
export type CmsSection = { id: string; title: string; payload: Record<string, unknown>; visible: boolean; position: number; component_code: string; component_type: string };

export type SitePage = { id: string; code: string; title: string; sections: CmsSection[]; hero: Record<string, unknown> | null };

/** GET /site/pages/:code → hero + ordered blocks (the storefront renderer consumes these). */
export function adaptSitePage(raw: unknown): SitePage | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) return null;
  const sections = (Array.isArray(row.sections) ? row.sections : []).map((item) => {
    const section = (item ?? {}) as Record<string, unknown>;
    return {
      id: asString(section.id), title: asString(section.title),
      payload: (section.payload ?? {}) as Record<string, unknown>,
      visible: section.visible !== false, position: Number(section.position ?? 0) || 0,
      component_code: asString(section.component_code ?? section.componentCode),
      component_type: asString(section.component_type ?? section.componentType),
    };
  }).sort((a, b) => a.position - b.position);
  const heroSection = sections.find((section) => section.component_code === "hero" && section.visible);
  return {
    id, code: asString(row.code), title: asString(row.title), sections,
    hero: heroSection ? { ...heroSection.payload, visible: true, position: 0 } : null,
  };
}

/**
 * Maps a CMS section (component code + payload) onto the storefront renderer's block vocabulary.
 * The admin console writes sections; the storefront renders `{ id, type, name, enabled, props }`.
 */
export function adaptCmsSectionToBlock(section: CmsSection): { id: string; type: string; name: string; enabled: boolean; props: Record<string, unknown> } {
  const payload = section.payload ?? {};
  const type = section.component_type === "product_slider" ? "product_grid"
    : section.component_type === "cta" ? "banner"
      : section.component_type === "category_section" ? "category_grid"
        : section.component_type === "promotional" ? "banner"
          : section.component_type === "text_image" ? "editorial"
            : section.component_type ?? "banner";
  const target = typeof payload.ctaTarget === "string" ? payload.ctaTarget : undefined;
  return {
    id: section.id,
    type,
    name: section.title || CMS_BOOTSTRAP_SECTION_LABEL[section.component_code] || section.component_code,
    enabled: section.visible,
    props: {
      ...payload,
      title: payload.title ?? section.title,
      text: payload.text ?? payload.subtitle ?? payload.heading,
      cta: payload.ctaLabel, target,
    },
  };
}

/** Storefront hero config derived from the CMS «hero» section payload. */
export function adaptCmsHero(section: CmsSection | null): Record<string, unknown> | null {
  if (!section) return null;
  const payload = section.payload ?? {};
  return {
    eyebrow: payload.eyebrow ?? "", title: payload.title ?? "", subtitle: payload.subtitle ?? "",
    ctaLabel: payload.ctaLabel ?? "", ctaTarget: payload.ctaTarget ?? "shop",
    image: payload.image ?? null, layout: payload.layout ?? "split", visible: section.visible,
  };
}

export const CMS_BOOTSTRAP_SECTION_LABEL: Record<string, string> = {
  hero: "هیرو صفحه اصلی", product_slider: "اسلایدر محصولات", cta: "دعوت به اقدام",
  banner: "بنر", category_section: "دسته‌بندی‌ها", promotional: "بخش تبلیغاتی", text_image: "متن و تصویر",
  faq: "پرسش‌های متداول", blog_section: "مقالات", brand_section: "برندها", custom: "سفارشی",
};

/** Palette labels — backend codes stay English. */
export const PALETTE_MODE_LABEL: Record<string, string> = { manual: "دستی", scheduled: "زمان‌بندی‌شده", festival: "جشنواره" };
export const PALETTE_COLOR_LABEL: Record<string, string> = {
  primary: "رنگ اصلی", secondary: "رنگ دوم", accent: "رنگ تأکیدی",
  background: "پس‌زمینه", surface: "سطح", text: "متن",
};

/** POST /admin/cms/bootstrap result. */
export type CmsBootstrapResult = {
  pageId: string; pageCreated: boolean; sectionsCreated: number;
  paletteId: string; paletteCreated: boolean; paletteActivated: boolean;
  hero: { id: string; title: string; payload: Record<string, unknown> } | null;
};

export function readCmsBootstrap(raw: unknown): CmsBootstrapResult {
  const row = (raw ?? {}) as Record<string, unknown>;
  if (!asNullableString(row.pageId)) throw new ContractError("راه‌اندازی صفحه اصلی ناموفق بود.");
  const hero = row.hero as { id?: unknown; title?: unknown; payload?: unknown } | null | undefined;
  return {
    pageId: asString(row.pageId), pageCreated: row.pageCreated === true, sectionsCreated: Number(row.sectionsCreated ?? 0) || 0,
    paletteId: asString(row.paletteId), paletteCreated: row.paletteCreated === true, paletteActivated: row.paletteActivated === true,
    hero: hero && hero.id ? { id: asString(hero.id), title: asString(hero.title), payload: (hero.payload ?? {}) as Record<string, unknown> } : null,
  };
}

/* ============================== Promo (coupons & festivals) ============================== */

export const COUPON_TYPE_LABEL: Record<string, string> = { percent: "درصدی", fixed: "مبلغ ثابت" };
export const COUPON_SOURCE_LABEL: Record<string, string> = {
  manual: "دستی", crm: "مدیریت مشتریان", festival: "جشنواره", welcome: "خوش‌آمدگویی", seed: "داده اولیه",
};
export const PROMO_AUDIENCE_LABEL: Record<string, string> = {
  customer: "مشتری عادی", vip: "ویژه", wholesale: "عمده", all: "همه",
};
export const PROMO_SCOPE_LABEL: Record<string, string> = { productIds: "محصولات", categories: "دسته‌بندی‌ها" };
export const labelOf = (map: Record<string, string>, code: unknown, fallback = "—"): string =>
  (typeof code === "string" && map[code]) || fallback;

/* ============================== Integrations ============================== */

export const INTEGRATION_CATEGORIES = ["payment", "sms", "shipping", "marketplace", "finance", "crm", "other"] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];
export const INTEGRATION_CATEGORY_LABEL: Record<IntegrationCategory, string> = {
  payment: "پرداخت", sms: "پیامک", shipping: "حمل‌ونقل", marketplace: "بازارچه",
  finance: "مالی/حسابداری", crm: "مدیریت ارتباط با مشتری", other: "سایر",
};

export type IntegrationEnvironment = "test" | "production";
export const INTEGRATION_ENVIRONMENT_LABEL: Record<IntegrationEnvironment, string> = {
  test: "آزمایشی", production: "عملیاتی",
};
export const INTEGRATION_STATUS_LABEL: Record<string, string> = {
  not_configured: "پیکربندی نشده", connected: "متصل", error: "خطا",
};
export const INTEGRATION_ACTION_LABEL: Record<string, string> = {
  test_connection: "تست اتصال", webhook: "وبهوک ورودی", sync: "همگام‌سازی", callback: "بازگشت از درگاه", retry: "تلاش مجدد",
};
export const INTEGRATION_LOG_STATUS_LABEL: Record<string, string> = {
  success: "موفق", failure: "ناموفق", retry: "تلاش مجدد", rejected: "رد شده",
};

/** Exactly the wire shape of GET /admin/integrations (secrets are never returned — only `hasSecret`). */
export type IntegrationView = {
  id: string; code: string; title: string; category: IntegrationCategory; provider: string;
  environment: IntegrationEnvironment; enabled: boolean; config: Record<string, unknown>;
  hasSecret: boolean; secretHint: string | null; status: string; lastSuccessAt: string | null;
  lastError: string | null; lastErrorAt: string | null; webhookUrl: string | null; callbackUrl: string | null;
  syncStatus: string;
};

export function normalizeIntegrations(raw: unknown): IntegrationView[] {
  return (((raw ?? {}) as { items?: unknown[] }).items ?? []).map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const category = asString(row.category, "other");
    return {
      id: asString(row.id), code: asString(row.code), title: asString(row.title),
      category: (INTEGRATION_CATEGORIES as readonly string[]).includes(category) ? category as IntegrationCategory : "other",
      provider: asString(row.provider, "generic"),
      environment: (row.environment === "production" ? "production" : "test") as IntegrationEnvironment,
      enabled: row.enabled === true, config: (row.config ?? {}) as Record<string, unknown>,
      hasSecret: row.hasSecret === true, secretHint: asNullableString(row.secretHint),
      status: asString(row.status, "not_configured"), lastSuccessAt: asNullableString(row.lastSuccessAt ?? row.last_success_at),
      lastError: asNullableString(row.lastError ?? row.last_error), lastErrorAt: asNullableString(row.lastErrorAt ?? row.last_error_at),
      webhookUrl: asNullableString(row.webhookUrl ?? row.webhook_url), callbackUrl: asNullableString(row.callbackUrl ?? row.callback_url),
      syncStatus: asString(row.syncStatus ?? row.sync_status, "idle"),
    };
  });
}

export type IntegrationLog = {
  id: string; direction: string; action: string; status: string; httpStatus: number | null;
  attempt: number; createdAt: string; responseSummary: Record<string, unknown>;
};

export function normalizeIntegrationLogs(raw: unknown): IntegrationLog[] {
  return (((raw ?? {}) as { items?: unknown[] }).items ?? []).map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      id: asString(row.id), direction: asString(row.direction), action: asString(row.action),
      status: asString(row.status), httpStatus: row.http_status === null || row.http_status === undefined ? null : Number(row.http_status),
      attempt: Number(row.attempt ?? 1) || 1, createdAt: asString(row.created_at ?? row.createdAt),
      responseSummary: (row.response_summary ?? row.responseSummary ?? {}) as Record<string, unknown>,
    };
  });
}

/** Known providers get a purpose-built form instead of raw JSON (item 23). */
/** Order status codes are English in the API; the console always renders Persian. */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending_payment: "در انتظار پرداخت", paid: "پرداخت شد", processing: "در حال پردازش",
  preparing: "در حال آماده‌سازی", ready_to_ship: "آماده ارسال", in_transit: "در حال ارسال",
  shipped: "ارسال شد", delivered: "تحویل شد", cancelled: "لغو شد", returned: "مرجوعی",
  refunded: "بازگشت وجه", pending: "در انتظار", approved: "تأییدشده", draft: "پیش‌نویس",
  issued: "صادرشده", void: "ابطال‌شده", open: "باز", closed: "بسته",
};
/** Persian label for a status code, falling back to the raw value when it is already Persian. */
export const orderStatusLabel = (code: string | null | undefined) =>
  code ? ORDER_STATUS_LABEL[code] ?? code : "—";

/** Plan feature codes are stored in English (API contract); the console shows readable text. */
export const PLAN_FEATURE_LABEL: Record<string, string> = {
  wholesale_catalog: "دسترسی به کاتالوگ عمده", wholesale_pricing: "قیمت‌گذاری عمده",
  credit_line: "خط اعتباری خرید", priority_support: "پشتیبانی اولویت‌دار",
  dedicated_agent: "کارشناس اختصاصی", early_access: "دسترسی زودتر به کالکشن",
  free_shipping: "ارسال رایگان", try_on_studio: "استودیوی پرو مجازی",
  installment_payment: "پرداخت اقساطی", bulk_discount: "تخفیف خرید عمده",
};
/** Unknown codes are shown as-is: the code is the contract, the label is presentation. */
export const planFeatureLabel = (code: string) => PLAN_FEATURE_LABEL[code] ?? code;

export type ProviderField = { key: string; label: string; hint?: string; kind: "text" | "url" | "secret" | "switch" };
export const PROVIDER_PRESETS: Record<string, { title: string; category: IntegrationCategory; fields: ProviderField[] }> = {
  zibal: { title: "درگاه پرداخت زیبال", category: "payment", fields: [
    { key: "merchantCode", label: "کد پذیرنده (Merchant)", kind: "text" },
    { key: "testUrl", label: "نشانی سرویس تأیید", kind: "url", hint: "برای تست اتصال استفاده می‌شود" },
  ] },
  nextpay: { title: "درگاه پرداخت نکست‌پی", category: "payment", fields: [
    { key: "apiKey", label: "کلید API", kind: "secret" }, { key: "testUrl", label: "نشانی سرویس تأیید", kind: "url" },
  ] },
  melipayamak: { title: "پیامک ملی‌پیامک", category: "sms", fields: [
    { key: "username", label: "نام کاربری", kind: "text" }, { key: "sender", label: "شماره فرستنده", kind: "text" },
    { key: "testUrl", label: "نشانی سرویس تأیید", kind: "url" },
  ] },
  n8n: { title: "اتوماسیون n8n", category: "other", fields: [
    { key: "webhookUrl", label: "نشانی وبهوک (Webhook URL)", kind: "url" },
  ] },
  s3: { title: "ذخیره‌سازی سازگار با S3", category: "other", fields: [
    { key: "endpoint", label: "نشانی سرویس (Endpoint)", kind: "url" }, { key: "bucket", label: "نام باکت", kind: "text" },
    { key: "region", label: "منطقه", kind: "text" },
  ] },
  smtp: { title: "ایمیل (SMTP)", category: "other", fields: [
    { key: "host", label: "میزبان", kind: "text" }, { key: "port", label: "درگاه", kind: "text" },
    { key: "from", label: "نشانی فرستنده", kind: "text" },
  ] },
  erp: { title: "سامانه ERP / WMS", category: "finance", fields: [
    { key: "baseUrl", label: "نشانی سرور", kind: "url" }, { key: "companyCode", label: "کد شرکت", kind: "text" },
  ] },
  crm: { title: "سامانه مدیریت ارتباط با مشتری (CRM)", category: "crm", fields: [
    { key: "baseUrl", label: "نشانی سرور", kind: "url" }, { key: "pipeline", label: "خط فروش", kind: "text" },
  ] },
  generic: { title: "سرویس عمومی", category: "other", fields: [
    { key: "testUrl", label: "نشانی تست اتصال", kind: "url" }, { key: "authHeaderName", label: "نام هدر احراز هویت", kind: "text" },
  ] },
};
export type ProviderPreset = { title: string; category: IntegrationCategory; fields: ProviderField[] };
export const providerPreset = (provider: string): ProviderPreset => PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS.generic!;
/** Provider keys are technical; the select shows the Persian service name. */
export const normalizedProvider = (provider: string) => providerPreset(provider).title;

/* ====================== Product structure (items 4-10, 122-135, 245-247) ====================== */

/** Product type with its sizes — GET /product-types (items 4-6). Sizes render from here, never hardcoded. */
export type ProductTypeSize = { id: string; code: string; label: string; active: boolean; position: number };
export type ProductType = {
  id: string; code: string; name: string; description: string;
  active: boolean; position: number; specTemplateId: string | null; sizes: ProductTypeSize[];
};

export function normalizeProductTypeSize(raw: unknown): ProductTypeSize | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) return null;
  return {
    id, code: asString(row.code), label: asString(row.label),
    active: row.active !== false, position: Number(row.position ?? 0) || 0,
  };
}

export function normalizeProductType(raw: unknown): ProductType | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) return null;
  return {
    id, code: asString(row.code), name: asString(row.name), description: asString(row.description),
    active: row.active !== false, position: Number(row.position ?? 0) || 0,
    specTemplateId: asNullableString(row.specTemplateId ?? row.spec_template_id),
    sizes: (Array.isArray(row.sizes) ? (row.sizes as unknown[]) : [])
      .map(normalizeProductTypeSize).filter((size): size is ProductTypeSize => size !== null),
  };
}

export const normalizeProductTypes = (raw: unknown): ProductType[] =>
  (((raw ?? {}) as { items?: unknown[] }).items ?? []).map(normalizeProductType)
    .filter((type): type is ProductType => type !== null);

/** Gender / season taxonomy — GET /taxonomies (items 245-247). */
export type TaxonomyKind = "gender" | "season";
export type Taxonomy = { id: string; kind: TaxonomyKind; code: string; label: string; active: boolean; position: number };

export function normalizeTaxonomy(raw: unknown): Taxonomy | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  const kind = row.kind === "gender" || row.kind === "season" ? row.kind : null;
  if (!id || !kind) return null;
  return {
    id, kind, code: asString(row.code), label: asString(row.label),
    active: row.active !== false, position: Number(row.position ?? 0) || 0,
  };
}

export const normalizeTaxonomies = (raw: unknown): Taxonomy[] =>
  (((raw ?? {}) as { items?: unknown[] }).items ?? []).map(normalizeTaxonomy)
    .filter((item): item is Taxonomy => item !== null);

/* ====================== Dynamic specs (items 122-128) ====================== */

export const SPEC_TYPES = ["text", "textarea", "number", "decimal", "boolean", "single_select", "multi_select", "color", "date", "measurement", "file", "image", "video", "url"] as const;
export type SpecAttributeType = (typeof SPEC_TYPES)[number];
export const SPEC_TYPE_LABEL: Record<SpecAttributeType, string> = {
  text: "متن کوتاه", textarea: "متن بلند", number: "عدد صحیح", decimal: "عدد اعشاری",
  boolean: "بله/خیر", single_select: "تک‌انتخابی", multi_select: "چندانتخابی", color: "رنگ",
  date: "تاریخ", measurement: "اندازه", file: "فایل", image: "تصویر", video: "ویدیو", url: "نشانی",
};
export const isSpecAttributeType = (value: unknown): value is SpecAttributeType =>
  typeof value === "string" && (SPEC_TYPES as readonly string[]).includes(value);

export type SpecOption = { id: string; value: string; label: string; position: number };
export type SpecAttribute = {
  id: string; code: string; label: string; description: string; type: SpecAttributeType;
  unit: string | null; required: boolean; searchable: boolean; filterable: boolean;
  scope: "product" | "variant"; position: number; validation: Record<string, unknown>;
  active: boolean; options: SpecOption[];
};

export function normalizeSpecAttribute(raw: unknown): SpecAttribute | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id || !isSpecAttributeType(row.type)) return null;
  return {
    id, code: asString(row.code), label: asString(row.label), description: asString(row.description), type: row.type,
    unit: asNullableString(row.unit), required: row.required === true, searchable: row.searchable === true,
    filterable: row.filterable === true, scope: row.scope === "variant" ? "variant" : "product",
    position: Number(row.position ?? 0) || 0,
    validation: (row.validation ?? {}) as Record<string, unknown>,
    active: row.active !== false,
    options: (Array.isArray(row.options) ? (row.options as unknown[]) : []).map((option) => {
      const item = (option ?? {}) as Record<string, unknown>;
      return { id: asString(item.id), value: asString(item.value), label: asString(item.label), position: Number(item.position ?? 0) || 0 };
    }),
  };
}

export const normalizeSpecAttributes = (raw: unknown): SpecAttribute[] =>
  (((raw ?? {}) as { items?: unknown[] }).items ?? []).map(normalizeSpecAttribute)
    .filter((item): item is SpecAttribute => item !== null);

export type SpecGroup = { id: string; name: string; position: number };
export type SpecTemplate = {
  id: string; code: string; name: string; description: string; active: boolean;
  groups: SpecGroup[]; attributes: (SpecAttribute & { groupId: string | null; inTemplatePosition: number })[];
};

export function normalizeSpecTemplate(raw: unknown): SpecTemplate | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) return null;
  return {
    id, code: asString(row.code), name: asString(row.name), description: asString(row.description),
    active: row.active !== false,
    groups: (Array.isArray(row.groups) ? (row.groups as unknown[]) : []).map((group) => {
      const item = (group ?? {}) as Record<string, unknown>;
      return { id: asString(item.id), name: asString(item.name), position: Number(item.position ?? 0) || 0 };
    }),
    attributes: (Array.isArray(row.attributes) ? (row.attributes as unknown[]) : []).map((attribute) => {
      const base = normalizeSpecAttribute(attribute);
      const item = (attribute ?? {}) as Record<string, unknown>;
      return base ? { ...base, groupId: asNullableString(item.groupId ?? item.group_id), inTemplatePosition: Number(item.inTemplatePosition ?? item.in_template_position ?? 0) || 0 } : null;
    }).filter((item): item is SpecAttribute & { groupId: string | null; inTemplatePosition: number } => item !== null),
  };
}

/** GET /products/:id/specs — template (from the product type) + stored values. */
export type ProductSpecs = {
  productId: string;
  template: SpecTemplate | null;
  values: { id: string; variantId: string | null; attributeId: string; code: string; label: string; type: SpecAttributeType; unit: string | null; scope: string; value: unknown }[];
};

export function readProductSpecs(raw: unknown): ProductSpecs {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    productId: asString(row.productId ?? row.product_id),
    template: row.template ? normalizeSpecTemplate(row.template) : null,
    values: (Array.isArray(row.values) ? (row.values as unknown[]) : []).map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        id: asString(item.id), variantId: asNullableString(item.variantId ?? item.variant_id),
        attributeId: asString(item.attributeId ?? item.attribute_id),
        code: asString(item.code), label: asString(item.label),
        type: isSpecAttributeType(item.type) ? item.type : "text",
        unit: asNullableString(item.unit), scope: asString(item.scope, "product"), value: item.value ?? null,
      };
    }),
  };
}

/* ====================== Size guides (items 129-134) ====================== */

export type SizeGuideColumn = { id: string; code: string; label: string; unit: string | null; position: number };
export type SizeGuideRow = { id: string; values: Record<string, string>; position: number };
export type SizeGuideMedia = { id: string; kind: string; caption: string; position: number; fileId: string; originalName: string; mimeType: string; sizeBytes: number };
export type SizeGuide = {
  id: string; code: string; name: string; description: string;
  version: number; supersedesId: string | null; status: string;
  columns: SizeGuideColumn[]; rows: SizeGuideRow[]; media: SizeGuideMedia[];
};

export function normalizeSizeGuide(raw: unknown): SizeGuide | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) return null;
  return {
    id, code: asString(row.code), name: asString(row.name), description: asString(row.description),
    version: Number(row.version ?? 1) || 1, supersedesId: asNullableString(row.supersedesId ?? row.supersedes_id),
    status: asString(row.status, "active"),
    columns: (Array.isArray(row.columns) ? (row.columns as unknown[]) : []).map((column) => {
      const item = (column ?? {}) as Record<string, unknown>;
      return { id: asString(item.id), code: asString(item.code), label: asString(item.label), unit: asNullableString(item.unit), position: Number(item.position ?? 0) || 0 };
    }),
    rows: (Array.isArray(row.rows) ? (row.rows as unknown[]) : []).map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return { id: asString(item.id), values: (item.values ?? {}) as Record<string, string>, position: Number(item.position ?? 0) || 0 };
    }),
    media: (Array.isArray(row.media) ? (row.media as unknown[]) : []).map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        id: asString(item.id), kind: asString(item.kind), caption: asString(item.caption),
        position: Number(item.position ?? 0) || 0, fileId: asString(item.fileId ?? item.file_id),
        originalName: asString(item.originalName ?? item.original_name),
        mimeType: asString(item.mimeType ?? item.mime_type), sizeBytes: Number(item.sizeBytes ?? item.size_bytes ?? 0) || 0,
      };
    }),
  };
}

export const normalizeSizeGuides = (raw: unknown): SizeGuide[] =>
  (((raw ?? {}) as { items?: unknown[] }).items ?? []).map(normalizeSizeGuide)
    .filter((item): item is SizeGuide => item !== null);

export const SIZE_GUIDE_STATUS_LABEL: Record<string, string> = { draft: "پیش‌نویس", active: "فعال", archived: "بایگانی" };

/* ====================== Marketplace review (items 37-39) ====================== */

export type ReviewReason = { id: string; code: string; label: string; active: boolean; position: number };
export const normalizeReviewReasons = (raw: unknown): ReviewReason[] =>
  (((raw ?? {}) as { items?: unknown[] }).items ?? []).map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const id = asNullableString(row.id);
    if (!id) return null;
    return {
      id, code: asString(row.code), label: asString(row.label),
      active: row.active !== false, position: Number(row.position ?? 0) || 0,
    };
  }).filter((item): item is ReviewReason => item !== null);

export type MarketplaceProduct = {
  id: string; brand: string; name: string; category: string; status: string;
  cashPriceRial: string; installmentPriceRial: string | null; wholesalePriceRial: string | null;
  wholesaleMoq: number | null; productTypeId: string | null; supplierId: string | null;
  supplierName: string | null; variantCount: number; createdAt: string; updatedAt: string;
  lastDecision: string | null; lastReason: string | null; lastNote: string | null; lastReviewedAt: string | null;
};

export function normalizeMarketplaceProduct(raw: unknown): MarketplaceProduct | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) return null;
  return {
    id, brand: asString(row.brand), name: asString(row.name), category: asString(row.category),
    status: asString(row.status),
    cashPriceRial: asString(row.cashPriceRial ?? row.cash_price_rial, "0"),
    installmentPriceRial: asNullableString(row.installmentPriceRial ?? row.installment_price_rial),
    wholesalePriceRial: asNullableString(row.wholesalePriceRial ?? row.wholesale_price_rial),
    wholesaleMoq: (row.wholesaleMoq ?? row.wholesale_moq ?? null) as number | null,
    productTypeId: asNullableString(row.productTypeId ?? row.product_type_id),
    supplierId: asNullableString(row.supplierId ?? row.supplier_id),
    supplierName: asNullableString(row.supplierName ?? row.supplier_name ?? row.brand_name),
    variantCount: Number(row.variantCount ?? row.variant_count ?? 0) || 0,
    createdAt: asString(row.createdAt ?? row.created_at), updatedAt: asString(row.updatedAt ?? row.updated_at),
    lastDecision: asNullableString(row.lastDecision ?? row.last_decision),
    lastReason: asNullableString(row.lastReason ?? row.last_reason),
    lastNote: asNullableString(row.lastNote ?? row.last_note),
    lastReviewedAt: asNullableString(row.lastReviewedAt ?? row.last_reviewed_at),
  };
}

export const normalizeMarketplaceProducts = (raw: unknown): MarketplaceProduct[] =>
  (((raw ?? {}) as { items?: unknown[] }).items ?? []).map(normalizeMarketplaceProduct)
    .filter((item): item is MarketplaceProduct => item !== null);

export type ProductReview = {
  id: string; decision: string; documentsChecked: boolean; checklist: Record<string, boolean>;
  reasonCode: string | null; reasonLabel: string | null; note: string | null;
  reviewerId: string; reviewerName: string | null; createdAt: string;
};

export function normalizeProductReview(raw: unknown): ProductReview | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) return null;
  return {
    id, decision: asString(row.decision), documentsChecked: (row.documentsChecked ?? row.documents_checked) === true,
    checklist: (row.checklist ?? {}) as Record<string, boolean>,
    reasonCode: asNullableString(row.reasonCode ?? row.reason_code),
    reasonLabel: asNullableString(row.reasonLabel ?? row.reason_label),
    note: asNullableString(row.note),
    reviewerId: asString(row.reviewerId ?? row.reviewer_id),
    reviewerName: asNullableString(row.reviewerName ?? row.reviewer_name),
    createdAt: asString(row.createdAt ?? row.created_at),
  };
}

export const REVIEW_DECISION_LABEL: Record<string, string> = { approved: "تأیید", rejected: "رد", changes_requested: "نیازمند اصلاح" };

/* ====================== Import center (items 40-45) ====================== */

export const IMPORT_TYPES = ["products", "inventory", "users"] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];
export const IMPORT_TYPE_LABEL: Record<ImportType, string> = { products: "محصول", inventory: "موجودی", users: "کاربر" };
export const IMPORT_MODE_LABEL: Record<string, string> = { create_only: "فقط ایجاد", update: "فقط به‌روزرسانی", create_update: "ایجاد و به‌روزرسانی" };
export const IMPORT_MATCH_LABEL: Record<string, string> = { sku: "SKU", legacy_id: "کد قدیمی", product_code: "کد محصول", email: "ایمیل", phone: "موبایل" };
export const IMPORT_STATUS_LABEL: Record<string, string> = {
  queued: "در صف", running: "در حال اجرا", done: "تمام‌شده", failed: "ناموفق", cancelled: "لغوشده",
};

export type ImportJob = {
  id: string; type: ImportType; filename: string; format: string; mode: string; matchBy: string;
  mapping: { mapping: Record<string, string>; imageHeaders: string[] };
  status: string; totalRows: number; processedRows: number; succeededRows: number; failedRows: number; warningRows: number;
  report: Record<string, unknown>; createdByName: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null; durationSeconds: number | null;
};

export function normalizeImportJob(raw: unknown): ImportJob | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) return null;
  const mapping = (row.mapping ?? {}) as { mapping?: Record<string, string>; imageHeaders?: string[] };
  return {
    id,
    type: row.type === "inventory" || row.type === "users" ? row.type : "products",
    filename: asString(row.filename), format: asString(row.format), mode: asString(row.mode),
    matchBy: asString(row.matchBy ?? row.match_by),
    mapping: { mapping: mapping.mapping ?? {}, imageHeaders: mapping.imageHeaders ?? [] },
    status: asString(row.status),
    totalRows: Number(row.totalRows ?? row.total_rows ?? 0) || 0,
    processedRows: Number(row.processedRows ?? row.processed_rows ?? 0) || 0,
    succeededRows: Number(row.succeededRows ?? row.succeeded_rows ?? 0) || 0,
    failedRows: Number(row.failedRows ?? row.failed_rows ?? 0) || 0,
    warningRows: Number(row.warningRows ?? row.warning_rows ?? 0) || 0,
    report: (row.report ?? {}) as Record<string, unknown>,
    createdByName: asNullableString(row.createdByName ?? row.created_by_name),
    createdAt: asString(row.createdAt ?? row.created_at),
    startedAt: asNullableString(row.startedAt ?? row.started_at),
    finishedAt: asNullableString(row.finishedAt ?? row.finished_at),
    durationSeconds: (row.durationSeconds ?? row.duration_seconds ?? null) as number | null,
  };
}

export const normalizeImportJobs = (raw: unknown): ImportJob[] =>
  (((raw ?? {}) as { items?: unknown[] }).items ?? []).map(normalizeImportJob)
    .filter((item): item is ImportJob => item !== null);

/** Canonical import field labels per type (for the mapping step). */
export const IMPORT_FIELD_LABEL: Record<ImportType, Record<string, string>> = {
  products: {
    name: "نام محصول", brand: "برند", category: "دسته", description: "توضیحات",
    cashPrice: "قیمت نقدی", installmentPrice: "قیمت اقساطی", wholesalePrice: "قیمت عمده",
    productTypeCode: "کد نوع محصول", size: "سایز", color: "رنگ", weightGrams: "وزن (گرم)",
    gender: "جنسیت", seasons: "فصل‌ها", supplier: "تأمین‌کننده (ایمیل/موبایل)",
    importKey: "کلید تطبیق", sku: "SKU", installmentPolicy: "سیاست قسط", wholesaleMoq: "حداقل عمده",
  },
  inventory: { sku: "SKU", quantity: "تعداد", warehouseCode: "کد انبار", mode: "حالت (receipt/set)" },
  users: {
    name: "نام", email: "ایمیل", mobile: "موبایل", legacyId: "کد قدیمی",
    registeredAt: "تاریخ عضویت", level: "سطح", addressLine: "نشانی", addressCity: "شهر",
    addressProvince: "استان", addressPostal: "کد پستی", addressMobile: "موبایل گیرنده",
  },
};

/* ====================== Orders: sorts + pricing snapshot (items 1, 46-48) ====================== */

export const ORDER_SORTS = ["newest", "oldest", "status", "total", "buyer", "supplier", "payment", "fulfillment", "updated", "priority", "shipped"] as const;
export type OrderSort = (typeof ORDER_SORTS)[number];
export const ORDER_SORT_LABEL: Record<OrderSort, string> = {
  newest: "جدیدترین", oldest: "قدیمی‌ترین", status: "وضعیت", total: "مبلغ",
  buyer: "خریدار", supplier: "تأمین‌کننده", payment: "وضعیت پرداخت",
  fulfillment: "پیشرفت ارسال", updated: "آخرین به‌روزرسانی", priority: "اولویت اقدام", shipped: "زمان ارسال",
};

/** Server-authoritative pricing breakdown stored on every order (never recomputed client-side). */
export type PricingSnapshot = {
  baseSubtotalRial: string; planDiscountRial: string; promoDiscountRial: string; promoSource: string;
  totalDiscountRial: string; walletRedeemedRial: string; shippingRial: string; totalRial: string;
  installment: { eligible: boolean; count: number; perInstallmentRial?: string; totalRial?: string; reason?: string | null } | null;
  policies: { productId: string; policy: string }[];
  shipping: { methodId: string | null; ruleId: string | null; pricingType: string; totalWeightGrams: number } | null;
};

export function readPricingSnapshot(raw: unknown): PricingSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const installment = (row.installment ?? null) as Record<string, unknown> | null;
  const shipping = (row.shipping ?? null) as Record<string, unknown> | null;
  return {
    baseSubtotalRial: asString(row.baseSubtotalRial, "0"),
    planDiscountRial: asString(row.planDiscountRial, "0"),
    promoDiscountRial: asString(row.promoDiscountRial, "0"),
    promoSource: asString(row.promoSource, "none"),
    totalDiscountRial: asString(row.totalDiscountRial, "0"),
    walletRedeemedRial: asString(row.walletRedeemedRial, "0"),
    shippingRial: asString(row.shippingRial, "0"),
    totalRial: asString(row.totalRial, "0"),
    installment: installment ? {
      eligible: installment.eligible === true, count: Number(installment.count ?? 4) || 4,
      perInstallmentRial: asNullableString(installment.perInstallmentRial) ?? undefined,
      totalRial: asNullableString(installment.totalRial) ?? undefined,
      reason: asNullableString(installment.reason),
    } : null,
    policies: (Array.isArray(row.policies) ? (row.policies as unknown[]) : []).map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return { productId: asString(item.productId), policy: asString(item.policy) };
    }),
    shipping: shipping ? {
      methodId: asNullableString(shipping.methodId), ruleId: asNullableString(shipping.ruleId),
      pricingType: asString(shipping.pricingType, "flat"),
      totalWeightGrams: Number(shipping.totalWeightGrams ?? 0) || 0,
    } : null,
  };
}
