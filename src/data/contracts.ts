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
  stock: number;
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
  stock?: string;
};

/** Toman (UI) → Rial (server). Integer strings only; the backend regex is /^\\d+$/. */
export function rialFromToman(value: string | number | undefined | null): string {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  if (!digits) return "0";
  return (BigInt(digits) * 10n).toString();
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
    stock: Number(draft.stock) || 0,
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

/** POST /products response — SKUs come from `variants`, never from a top-level `sku`. */
export type ProductCreateResponse = { id: string; status: string; variants: { id: string; sku: string }[] };

export function readProductCreateResponse(raw: unknown): ProductCreateResponse {
  const row = (raw ?? {}) as Record<string, unknown>;
  const id = asNullableString(row.id);
  if (!id) throw new ContractError("پاسخ سرور برای ایجاد محصول شناسه ندارد.");
  const variants = (Array.isArray(row.variants) ? (row.variants as unknown[]) : []).map((variant) => {
    const item = (variant ?? {}) as Record<string, unknown>;
    return { id: asString(item.id), sku: asString(item.sku) };
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
