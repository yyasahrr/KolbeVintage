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

/** POST /products variant input. */
export type ProductVariantInput = { size?: string; color?: string; attributes: Record<string, string> };

/**
 * Colors × sizes → real variants. The client NEVER builds SKUs: the backend
 * generates `KV-<CATEGORY>-<sequence>` / `SP-…` per variant.
 */
export function buildProductVariants(colors: string[], sizes: string[]): ProductVariantInput[] {
  const cleanColors = colors.map((color) => color.trim()).filter(Boolean);
  const cleanSizes = sizes.map((size) => size.trim()).filter(Boolean);
  if (!cleanColors.length) throw new ContractError("دست‌کم یک رنگ محصول لازم است.");
  if (!cleanSizes.length) throw new ContractError("دست‌کم یک سایز محصول لازم است.");
  const variants: ProductVariantInput[] = [];
  for (const color of cleanColors) {
    for (const size of cleanSizes) variants.push({ size, color, attributes: {} });
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
  series: { name: string; pieces: number; moqSeries: number; pricePerSeries: number; colorIds: string[] }[];
  /** NOTE: stock is intentionally NOT part of metadata — availability comes from the WMS ledger. */
  compareAtRial: string | null;
  editorialSku: string | null;
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
  compareToman?: string;
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

  const variants = buildProductVariants(draft.colors.map((color) => color.name), draft.sizes);

  const metadata: ProductMetadata = {
    images: draft.images.map((image) => ({ fileId: image.fileId, url: image.url })),
    videoFileId: draft.videoFileId ?? null,
    fabric: draft.fabric?.trim() ?? "",
    care: draft.care?.trim() ?? "",
    seo: { title: draft.seoTitle?.trim() || name, slug: draft.slug?.trim() || "" },
    cutout: draft.cutout && draft.cutout.status !== "none" ? draft.cutout : null,
    channels: { retail: draft.retailOn, wholesale: draft.wholesaleOn, styleBuilder: draft.cutout?.status === "ready" },
    series: offered.map((series) => ({
      name: series.name, pieces: series.pieces, moqSeries: series.moqSeries,
      pricePerSeries: series.pricePerSeries, colorIds: series.colorIds ?? [],
    })),
    compareAtRial: draft.compareToman ? rialFromToman(draft.compareToman) : null,
    editorialSku: draft.editorialSku?.trim() || null,
  };

  return {
    brand, name, category,
    description: draft.description?.trim() ?? "",
    cashPriceRial: cashRial,
    ...(installmentRial ? { installmentPriceRial: installmentRial } : {}),
    ...(wholesaleRial ? { wholesalePriceRial: wholesaleRial } : {}),
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

/** Exactly the wire shape of GET /admin/shipping-methods (backend serializer). */
export type ShippingMethod = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  type: ShippingType;
  baseFeeRial: string;
  freeAboveRial: string | null;
  estimatedMinDays: number;
  estimatedMaxDays: number;
  config: Record<string, unknown>;
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
    baseFeeRial: asString(row.baseFeeRial ?? row.base_fee_rial, "0"),
    freeAboveRial: asNullableString(row.freeAboveRial ?? row.free_above_rial),
    estimatedMinDays: Number(row.estimatedMinDays ?? row.estimated_min_days ?? 0) || 0,
    estimatedMaxDays: Number(row.estimatedMaxDays ?? row.estimated_max_days ?? 0) || 0,
    config: (row.config ?? {}) as Record<string, unknown>,
  };
}

export const normalizeShippingMethods = (raw: unknown): ShippingMethod[] =>
  ((raw ?? {}) as { items?: unknown[] }).items?.map(normalizeShippingMethod).filter((m): m is ShippingMethod => m !== null) ?? [];

/** Building rules for a shipping method: the frontend only ever sends these keys. */
export type ShippingMethodInput = {
  code: string;
  name: string;
  type: ShippingType;
  active: boolean;
  baseFeeRial: string;
  freeAboveRial: string | null;
  estimatedMinDays: number;
  estimatedMaxDays: number;
  config?: Record<string, unknown>;
};

export function buildShippingMethodPayload(input: ShippingMethodInput): ShippingMethodInput {
  const code = input.code.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(code)) throw new ContractError("کد روش ارسال باید با حروف انگلیسی کوچک، عدد، - یا _ و بین ۲ تا ۴۰ نویسه باشد.");
  if (input.name.trim().length < 2) throw new ContractError("نام روش ارسال باید دست‌کم ۲ نویسه باشد.");
  if (!/^\d+$/.test(input.baseFeeRial)) throw new ContractError("هزینه پایه باید عدد صحیح (ریال) باشد.");
  if (input.freeAboveRial !== null && !/^\d+$/.test(input.freeAboveRial)) throw new ContractError("سقف ارسال رایگان باید عدد صحیح (ریال) باشد.");
  if (input.estimatedMaxDays < input.estimatedMinDays) throw new ContractError("حداکثر زمان تحویل نمی‌تواند کمتر از حداقل باشد.");
  return {
    code, name: input.name.trim(), type: input.type, active: input.active,
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
