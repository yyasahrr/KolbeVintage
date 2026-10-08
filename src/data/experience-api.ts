/**
 * Typed client for the Experience domains (CMS studio, Style intelligence, unified Profile/Account).
 * Goes through the single authenticated transport in ./api — never raw fetch.
 */
import { apiClient, getApiBaseUrl, publicApi } from "./api";

/** Server media paths (/api/v1/media/…) resolved against the configured API origin. */
export const mediaSrc = (url: string | null | undefined): string | undefined => {
  if (!url) return undefined;
  return url.startsWith("/api/") ? `${getApiBaseUrl()}${url}` : url;
};

/* ------------------------------ shared shapes ------------------------------ */

export type CommerceProduct = {
  id: string; name: string; brand: string; category: string; productType: string | null; gender: string;
  seasons: string[]; vibes: string[]; priceRial: string; installmentPriceRial: string | null; perInstallmentRial: string | null;
  compareAtRial: string | null; discountPercent: number; installmentEnabled: boolean; installmentProviders: string[];
  image: string | null; flatLay: string | null; available: number; isNew: boolean; createdAt: string; rating: number; reviewCount: number;
  cardTemplate?: string; variants: { id: string; sku: string; size: string | null; color: string | null; available: number }[];
  /** Server-computed from the Installment Provider domain (Req 189-191) — never calculated in the browser. */
  installmentsCount?: number | null; installmentOffers?: InstallmentOffer[];
};
export type InstallmentOffer = { provider: string; title: string; count: number; perInstallmentRial: string; totalRial: string; badge: string; terms: string; color: string };
export type InstallmentProviderPublic = { code: string; title: string; count: number; minOrderRial: string; maxOrderRial?: string | null; badge: string; terms: string; color: string; logoUrl: string | null };
export type InstallmentProviderAdmin = { code: string; title: string; integration_code: string | null; installments_count: number; min_order_rial: string; max_order_rial: string | null;
  fee_percent: string; badge_text: string; terms: string; brand_color: string; logo_url: string | null; position: number; active: boolean };

/** Rial (server money) → Toman for display. Always BigInt-safe on the way in. */
export const rialToToman = (rial: string | number | null | undefined) => {
  if (rial === null || rial === undefined || rial === "") return 0;
  try { return Number(BigInt(String(rial)) / 10n); } catch { return Math.round(Number(rial) / 10); }
};

export type Announcement = {
  id: string; title: string; mode: "static" | "marquee" | "ticker" | "slider" | "rotating"; priority: number;
  messages: { text: string; link?: string; ctaLabel?: string; icon?: string }[];
  style: { backgroundColor: string; textColor: string; fontFamily?: string; speed?: "slow" | "normal" | "fast"; direction?: "rtl" | "ltr";
    heightPx?: number; icon?: string; dismissible?: boolean; ctaLabel?: string; ctaTarget?: string; showCountdown?: boolean };
  bindingType: string; bindingId: string | null; campaign: { id: string; name: string; starts_at: string; ends_at: string } | null;
  binding?: { kind: "promotion" | "coupon" | "collection" | "landing_page"; target?: string; title?: string; code?: string; label?: string | null; discountPercent?: number | null; endsAt?: string | null } | null;
};
export type MegaMenuColumn = { id: string; title: string; menuId?: string; items: { label: string; category?: string; gender?: string; target?: string }[]; featuredVibe?: string;
  featuredCollection?: string; featuredCampaign?: string; promoTitle?: string; image?: string; imageAlt?: string };
export type HeaderConfig = {
  variant: "default" | "minimal" | "transparent" | "campaign" | "dark"; logoText: string; logoSubtext: string;
  showSearch: boolean; showWishlist: boolean; showCart: boolean; showAccount: boolean; showThemeToggle: boolean; ctaLabel: string; ctaTarget: string;
  ctaEnabled?: boolean; ctaVariant?: "solid" | "outline" | "ghost";
  menus: { id: string; label: string; target: string; order: number; active: boolean; vip?: boolean; hasMegaMenu?: boolean }[];
  megaMenu: MegaMenuColumn[];
  showAnnouncement?: boolean;
  mobileNav?: { showCategories: boolean; showVibes: boolean; items: { label: string; target: string }[] };
};
export type FooterConfig = {
  brandTitle: string; brandSubtitle: string; brandDescription: string;
  columns: { title: string; links: { label: string; target: string }[] }[];
  contact: { phone: string; address: string; email: string };
  social: { platform: string; label: string; url: string }[]; trustBadges: string[]; newsletterEnabled: boolean; copyright: string;
};
export type AccountAppearance = {
  welcomeBanner: { eyebrow: string; title: string; subtitle: string; tone: "navy" | "terra" | "stone" };
  promoCard: { enabled: boolean; title: string; subtitle: string; ctaLabel: string; ctaTarget: string };
  recommendationHeading: string;
  helpCards: { title: string; desc: string; action: string }[];
};
export type SiteLayout = { header: HeaderConfig | null; footer: FooterConfig | null; accountAppearance: AccountAppearance | null; announcements: Announcement[] };
export type SiteTheme = { id: string; code: string; name: string; mode: string; colors: Record<string, string>; design_tokens: Record<string, string> };

export type PageSection = {
  id: string; title: string; payload: Record<string, unknown>; visible: boolean; position: number; component_code: string; component_type: string;
  variant?: string; section_theme?: string; style_overrides?: Record<string, unknown>; responsive_config?: Record<string, unknown>; composition?: unknown;
  resolved?: { products?: CommerceProduct[]; campaign?: { id: string; name: string; starts_at: string; ends_at: string; live: boolean } | null;
    reviews?: ReviewWithPhotos[];
    reviewSummary?: { average: number; total: number; distribution?: { rating: number; n: number }[] };
    categories?: { id: string; name: string; slug: string; description: string; image_url: string | null; cover_url: string | null; card_template: string; card_style?: Record<string, unknown>; product_count?: number; icon?: string | null; parent_id?: string | null }[];
    customerPhotos?: { reviewId: string; url: string; productName: string; author: string }[];
    collection?: { code: string; title: string; description: string };
    collections?: { code: string; title: string; description: string; images: string[]; count: number }[];
    providers?: InstallmentProviderPublic[];
    recommendation?: { strategy: "for_you" | "similar" | "popular" | "trending"; personal: boolean; basedOn: Record<string, unknown>; fallback: boolean };
    heroEntity?: { type: string; title: string; subtitle?: string; image?: string | null; target?: string; priceRial?: string; compareAtRial?: string | null; perInstallmentRial?: string | null;
      installmentsCount?: number | null; available?: number; endsAt?: string; palette?: Record<string, string>; mosaic?: (string | null)[] } | null };
};
export type ReviewWithPhotos = { id: string; rating: number; title: string; body: string; display_name: string; product_name: string; verified_purchase: boolean; created_at: string; photos?: string[] };
/* ---------- SEO Domain (Req 235) ---------- */
export type SeoEntityType = "page" | "category" | "vibe" | "collection" | "product";
export type ResolvedSeo = {
  entityType: SeoEntityType; entityKey: string; title: string; description: string; canonical: string; robots: string; index: boolean;
  og: { title: string; description: string; image: string | null; url: string; type: string; siteName: string; locale: string };
  twitter: { card: string; title: string; description: string; image: string | null };
  jsonLd: Record<string, unknown>[]; source: "seo_domain" | "derived"; version: number | null;
};
export type SeoEntry = {
  id: string; title: string | null; description: string | null; canonical_path: string | null; robots_index: boolean; robots_follow: boolean;
  og_title: string | null; og_description: string | null; og_image: string | null; twitter_card: "summary" | "summary_large_image";
  schema_type: string | null; schema_extra: Record<string, unknown>; version: number; updated_at: string;
};
export type SeoWrite = {
  title?: string | null; description?: string | null; canonicalPath?: string | null; robotsIndex?: boolean; robotsFollow?: boolean;
  ogTitle?: string | null; ogDescription?: string | null; ogImage?: string | null; twitterCard?: "summary" | "summary_large_image";
  schemaType?: string | null; schemaExtra?: Record<string, unknown>; expectedVersion?: number;
};
export type SeoListItem = { type: SeoEntityType; key: string; name: string; active: boolean; hasEntry: boolean; title: string | null; index: boolean; version: number | null; health: "good" | "fair" | "poor"; warnings: string[] };
export const seoApi = {
  resolve: (type: SeoEntityType, key: string) => publicApi.get<ResolvedSeo>(`/seo/${type}/${encodeURIComponent(key)}`),
  list: (type?: SeoEntityType) => apiClient.get<{ items: SeoListItem[] }>(`/admin/seo${type ? `?type=${type}` : ""}`),
  detail: (type: SeoEntityType, key: string) => apiClient.get<{ subject: { name: string; description: string; path: string; image: string | null; active: boolean }; entry: SeoEntry | null; resolved: ResolvedSeo; check: { errors: string[]; warnings: string[] }; history: { version: number; created_at: string }[] }>(`/admin/seo/${type}/${encodeURIComponent(key)}`),
  preview: (type: SeoEntityType, key: string, payload: SeoWrite) => apiClient.post<{ resolved: ResolvedSeo; check: { errors: string[]; warnings: string[] } }>(`/admin/seo/${type}/${encodeURIComponent(key)}/preview`, payload),
  save: (type: SeoEntityType, key: string, payload: SeoWrite) => apiClient.put<{ id: string; version: number; warnings: string[]; resolved: ResolvedSeo }>(`/admin/seo/${type}/${encodeURIComponent(key)}`, payload),
};

export type SitePage = { id: string; code: string; title: string; /** snapshot path may be absent (resolved via seo/aliases instead) */ path?: string; page_type: string; status: string; seo: ResolvedSeo | null; publishedVersion?: number; sections: PageSection[] };

/* ------------------------------- public site ------------------------------- */

export const siteApi = {
  layout: () => publicApi.get<SiteLayout>("/site/layout"),
  theme: () => publicApi.get<{ theme: SiteTheme | null }>("/site/theme"),
  page: (code: string) => publicApi.get<SitePage>(`/site/pages/${encodeURIComponent(code)}`),
  resolvePath: (path: string) => publicApi.get<{ kind: "page"; code: string }>(`/site/resolve-path?path=${encodeURIComponent(path)}`),
  collection: (code: string) => publicApi.get<{ title: string; products: CommerceProduct[] }>(`/site/collections/${code}`),
  cardTemplates: () => publicApi.get<{ items: { code: string; name: string; variant: string; blocks: string[]; styles: Record<string, unknown> }[] }>("/site/card-templates"),
  vibes: () => publicApi.get<{ items: { id: string; slug: string; name: string; description: string }[] }>("/site/vibes"),
  categories: () => publicApi.get<{ items: { id: string; slug: string; name: string; parent_id: string | null; active: boolean }[] }>("/site/categories"),
  installmentProviders: () => publicApi.get<{ items: InstallmentProviderPublic[] }>("/installment-providers"),
  /** Recommendation Engine (Req 239): for_you uses the session when present, otherwise falls back to popular. */
  recommendations: (params: { strategy: "for_you" | "similar" | "popular" | "trending"; productId?: string; vibe?: string; limit?: number }) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return apiClient.get<{ strategy: string; items: CommerceProduct[]; basedOn: Record<string, unknown>; fallback: boolean }>(`/recommendations?${q}`)
      .catch(() => publicApi.get<{ strategy: string; items: CommerceProduct[]; basedOn: Record<string, unknown>; fallback: boolean }>(`/recommendations?${q}`));
  },
  lead: (payload: { pageCode: string; campaignSource?: string; fullName?: string; phone?: string; email?: string; consent: true }) =>
    publicApi.post<{ id: string }>("/site/leads", payload),
  /** Analytics hooks are fire-and-forget; failures never affect the UI. */
  event: (payload: { eventType: "component.view" | "banner.click" | "product_card.click" | "campaign.click" | "cta.click"; pageCode?: string; sectionId?: string; componentCode?: string; targetId?: string }) => {
    void publicApi.post("/site/events", payload).catch(() => undefined);
  },
};

/* ------------------------------ style intelligence ------------------------------ */

export type StyleFeatures = { dominantColors: string[]; productType: string; vibes: string[]; seasons: string[]; formality: number; pattern: string; fit: string; visualWeight: string };
export type StyleScore = {
  scoreVersion: string; total: number; valid: boolean; issues: string[]; explanation: string; derivedVibes: string[];
  breakdown: { colorHarmony: number; vibeMatch: number; seasonMatch: number; formalityMatch: number; silhouetteBalance: number; categoryCompatibility: number; patternCompatibility: number };
  suggestions?: { replaceProductId: string; replaceName: string; candidate: CommerceProduct; newScore: number }[];
};
export type StyleItem = { productId: string; variantId?: string | null; x: number; y: number; scale: number; z: number };
export type SavedStyle = { id: string; name: string; share_code: string; privacy: "private" | "unlisted" | "public"; version: number; items: StyleItem[];
  score: number; score_breakdown: StyleScore["breakdown"]; explanation: string; preview_data_url: string | null; updated_at: string; created_at: string;
  products?: CommerceProduct[]; currentBundlePriceRial?: string; allAvailable?: boolean };
export type StyleValidation = { items: { productId: string; name: string; purchasable: boolean; reason: string | null; variant: CommerceProduct["variants"][number] | null;
  unitPriceRial: string; quantity: number; alternatives: CommerceProduct[] }[]; purchasableCount: number; total: number; bundlePriceRial: string; message: string };

export const styleApi = {
  catalog: () => publicApi.get<{ items: (CommerceProduct & { styleCategory: string; features: StyleFeatures })[] }>("/style/catalog"),
  score: (items: { productId: string; color?: string | null }[]) => publicApi.post<StyleScore>("/style/score", { items }),
  completeLook: (productIds: string[]) => apiClient.post<{ added: CommerceProduct[]; score: StyleScore }>("/style/complete-look", { productIds })
    .catch(() => publicApi.post<{ added: CommerceProduct[]; score: StyleScore }>("/style/complete-look", { productIds })),
  validate: (items: { productId: string; variantId?: string | null; quantity?: number }[]) => publicApi.post<StyleValidation>("/style/validate", { items }),
  list: () => apiClient.get<{ items: SavedStyle[] }>("/styles"),
  save: (payload: { name: string; items: StyleItem[]; privacy?: SavedStyle["privacy"]; previewDataUrl?: string | null }) =>
    apiClient.post<{ id: string; shareCode: string; score: number }>("/styles", payload),
  update: (id: string, payload: Partial<{ name: string; items: StyleItem[]; privacy: SavedStyle["privacy"]; previewDataUrl: string | null }>) =>
    apiClient.patch<SavedStyle>(`/styles/${id}`, payload),
  remove: (id: string) => apiClient.del<{ deleted: boolean }>(`/styles/${id}`),
  shared: (code: string) => publicApi.get<SavedStyle & { products: CommerceProduct[]; owner_name: string }>(`/styles/shared/${code}`),
  event: (type: "style.created" | "style.purchased" | "style.shared", styleId?: string, productIds: string[] = []) =>
    void publicApi.post("/styles/events", { type, styleId, productIds }).catch(() => undefined),
  reviews: (productId: string) => publicApi.get<{ summary: { average: number; total: number; distribution: { rating: number; n: number }[] };
    items: { id: string; rating: number; title: string; body: string; verified_purchase: boolean; created_at: string; display_name: string; photos?: string[] }[] }>(`/products/${productId}/reviews`),
  submitReview: (productId: string, payload: { rating: number; title?: string; body?: string; photoFileIds?: string[] }) =>
    apiClient.post<{ status: string; verifiedPurchase: boolean; photos?: number }>(`/products/${productId}/reviews`, payload),
  myReviews: () => apiClient.get<{ mine: { id: string; product_id: string; product_name: string; rating: number; title: string; body: string; status: string; verified_purchase: boolean; created_at: string }[];
    reviewable: { product_id: string; name: string; reference: string; created_at: string }[] }>("/me/reviews"),
};

/* --------------------------- product types (adaptive form) --------------------------- */

export type SpecField = { code: string; label: string; group: string; fieldType: "text" | "number" | "select" | "multiselect" | "boolean"; options: string[]; required: boolean; filterable: boolean; unit?: string };
export type SizeDef = { code: string; label: string; position: number; active: boolean };
export type ProductType = { id: string; code: string; name: string; description: string; sizes: SizeDef[]; spec_template: SpecField[];
  size_guide_template: { columns?: string[]; rows?: string[][] }; position: number; active?: boolean; product_count?: number };

export const productTypesApi = {
  list: () => publicApi.get<{ items: ProductType[] }>("/product-types"),
  adminList: () => apiClient.get<{ items: ProductType[] }>("/admin/product-types"),
  create: (payload: { code: string; name: string; description?: string; sizes: SizeDef[]; specTemplate: SpecField[]; position?: number }) =>
    apiClient.post<{ id: string }>("/admin/product-types", payload),
  update: (id: string, payload: Partial<{ name: string; description: string; sizes: SizeDef[]; specTemplate: SpecField[]; active: boolean; position: number }>) =>
    apiClient.patch<ProductType>(`/admin/product-types/${id}`, payload),
};

/* ------------------------------- profile & account ------------------------------- */

export type ProfileResponse = {
  user: { id: string; displayName: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null; birthday: string | null;
    avatarUrl: string | null; city: string | null; postalCode: string | null; twoFactorEnabled: boolean; createdAt: string };
  roles: string[];
  roleProfiles: { customer: boolean; vip: Record<string, unknown> | null; membership: Record<string, unknown> | null; supplier: Record<string, string | null> | null;
    supplierPendingChange: { id: string; diff: SupplierDiff[]; status: string; created_at: string } | null };
  policy: { selfService: string[]; verifiedChange: string[]; supplierFree: string[]; supplierApproval: { key: string; label: string }[] };
};
export type SupplierDiff = { field: string; label: string; oldValue: string | null; newValue: string | null };
export type OtpTicket = { requestId: string; expiresAt: string; devCode?: string; target?: string };

export type DashboardResponse = {
  greetingName: string; avatarUrl: string | null;
  summary: { activeOrders: number; deliveredOrders: number; wishlist: number; savedStyles: number; savedCart?: number; coupons: number; loyalty: { points: number; tier: { code: string; label: string; next: number | null } } };
  activeOrder: null | { id: string; reference: string; status: string; tracking_code: string | null; total_rial: string; timeline: { key: string; label: string; done: boolean; at: string | null }[] };
  coupons: Coupon[]; invoices: InvoiceRow[]; reviewableCount: number;
  personalization: { forYou: CommerceProduct[]; recentlyViewed: CommerceProduct[]; buyAgain: CommerceProduct[]; wishlistProducts: CommerceProduct[];
    suggestedStyles: { id: string; name: string; share_code: string; score: number }[]; basedOnVibe: string | null };
  appearance: AccountAppearance | null;
};
export type Coupon = { id: string; code: string; type: "percent" | "fixed"; value: string; max_discount_rial: string | null; min_order_rial: string; campaign_name: string | null; source: string; ends_at: string; used: boolean; expired?: boolean };
export type SavedCart = { updatedAt: string | null; items: { productId: string; variantId: string | null; quantity: number; product: CommerceProduct | null;
  variant: CommerceProduct["variants"][number] | null; available: number; unavailable: boolean; quantityAdjusted: number }[] };
export type InvoiceRow = { id: string; reference: string; kind: string; status: string; total_rial: string; issue_date: string };

export const profileApi = {
  get: () => apiClient.get<ProfileResponse>("/profile"),
  update: (payload: Partial<{ firstName: string; lastName: string; birthday: string | null; city: string | null; postalCode: string | null }>) =>
    apiClient.patch<{ displayName: string }>("/profile", payload),
  uploadAvatar: (blob: Blob, mime: string) => {
    const form = new FormData(); form.append("file", blob, mime === "image/png" ? "avatar.png" : mime === "image/webp" ? "avatar.webp" : "avatar.jpg");
    return apiClient.upload<{ avatarUrl: string }>("/profile/avatar", form);
  },
  removeAvatar: () => apiClient.del<{ avatarUrl: null }>("/profile/avatar"),
  requestContactChange: (channel: "phone" | "email", value: string) => apiClient.post<OtpTicket & { channel: string; target: string }>("/profile/contact-change", { channel, value }),
  verifyContactChange: (requestId: string, code: string) => apiClient.post<{ channel: string; value: string }>(`/profile/contact-change/${requestId}/verify`, { code }),
  changePassword: (payload: { currentPassword: string; newPassword: string; confirmPassword: string }) => apiClient.post<{ changed: boolean; otherSessionsRevoked: number }>("/profile/password", payload),
  requestPasswordOtp: () => apiClient.post<OtpTicket>("/profile/password/otp"),
  setPasswordWithOtp: (requestId: string, payload: { code: string; newPassword: string; confirmPassword: string }) => apiClient.post<{ changed: boolean }>(`/profile/password/otp/${requestId}`, payload),
  security: () => apiClient.get<{ twoFactorEnabled: boolean; twoFactorMethod: string;
    sessions: { id: string; device_label: string; ip_address: string | null; created_at: string; last_active_at: string; current: boolean }[];
    loginHistory: { id: string; device_label: string; ip_address: string | null; method: string; succeeded: boolean; created_at: string }[] }>("/profile/security"),
  setTwoFactor: (enabled: boolean, currentPassword: string) => apiClient.post<{ twoFactorEnabled: boolean }>("/profile/security/2fa", { enabled, currentPassword }),
  revokeSession: (id: string) => apiClient.del<{ revoked: boolean; current: boolean }>(`/profile/sessions/${id}`),
  logoutAll: () => apiClient.post<{ revoked: number }>("/profile/sessions/logout-all"),
  supplierPublic: (payload: Partial<{ avatarUrl: string | null; bio: string; publicDescription: string; contactPerson: string }>) => apiClient.patch<Record<string, string>>("/supplier-profile/public", payload),
  supplierChangeRequest: (changes: Record<string, string | null>, note?: string) => apiClient.post<{ id: string; diff: SupplierDiff[] }>("/supplier-profile/change-requests", { changes, note }),
  savedCart: () => apiClient.get<SavedCart>("/profile/saved-cart"),
  saveCart: (items: { productId: string; variantId: string | null; quantity: number }[]) => apiClient.put<SavedCart>("/profile/saved-cart", { items }),
  supplierChangeRequests: () => apiClient.get<{ items: { id: string; diff: SupplierDiff[]; status: string; supplier_note: string | null; review_note: string | null; reviewed_at: string | null; created_at: string }[] }>("/supplier-profile/change-requests"),
};

export const accountApi = {
  dashboard: () => apiClient.get<DashboardResponse>("/account/dashboard"),
  timeline: () => apiClient.get<{ items: { kind: string; title: string; at: string; ref: string }[] }>("/account/timeline"),
  coupons: () => apiClient.get<{ items: Coupon[] }>("/account/coupons"),
  invoices: () => apiClient.get<{ items: InvoiceRow[] }>("/account/invoices"),
  view: (productId: string) => void apiClient.post("/account/views", { productId }).catch(() => undefined),
};

/* ------------------------------- CMS studio (admin) ------------------------------- */

type Items<T> = { items: T[] };
/* Typed field schema (Req 175-176): the editor renders these, the server validates them. */
export type FieldType = "text" | "textarea" | "lines" | "number" | "boolean" | "select" | "media" | "video" | "target" | "color" | "datetime" | "collection" | "campaign" | "product" | "category" | "vibe" | "installment_provider";
export type FieldDef = { key: string; type: FieldType; label: string; group: "content" | "data" | "layout" | "style" | "media" | "behavior"; options?: string[]; default?: unknown; min?: number; max?: number;
  required?: boolean; advanced?: boolean; showIf?: Record<string, string>; hint?: string };
export type ComponentPreset = { id: string; component_code: string; code: string; title: string; variant: string; payload: Record<string, unknown>; style_overrides: Record<string, unknown>; responsive_config: Record<string, unknown>; position: number };
export type RegistryComponent = { id: string; code: string; title: string; kind: string; component_type: string; active: boolean; variants: string[]; presets: string[];
  field_schema: { version?: number; props?: string[]; fields?: FieldDef[] } | Record<string, unknown>; presetDefinitions: ComponentPreset[]; composition?: unknown };
export type AdminSection = { id: string; componentCode: string; title: string; payload: Record<string, unknown>; visible: boolean; position: number; variant: string | null; preset: string | null;
  sectionTheme: string | null; styleOverrides: Record<string, string | number>; responsiveConfig: Record<string, unknown> };
export const studioApi = {
  registry: () => apiClient.get<{ items: RegistryComponent[]; primitives: string[]; styleSpec: Record<string, { values: string[]; simple: boolean }>; simpleStyleKeys: string[] }>("/admin/cms/registry"),
  applyPreset: (sectionId: string, presetCode: string) => apiClient.post<Record<string, unknown>>(`/admin/cms/sections/${sectionId}/apply-preset`, { presetCode }),
  validatePayload: (componentCode: string, payload: Record<string, unknown>) => apiClient.post<{ payload: Record<string, unknown> }>(`/admin/cms/components/${componentCode}/validate`, payload),
  installmentProviders: () => apiClient.get<{ items: InstallmentProviderAdmin[]; integrations: { code: string; title: string; enabled: boolean; status: string }[] }>("/admin/installment-providers"),
  saveInstallmentProvider: (code: string, payload: Record<string, unknown>) => apiClient.put<InstallmentProviderAdmin>(`/admin/installment-providers/${code}`, payload),
  mediaRuns: (params: { subjectType?: string; subjectId?: string } = {}) => apiClient.get<Items<{ id: string; subject_type: string; subject_id: string; status: string; steps: { step: string; status: string; detail?: string }[]; metadata: Record<string, unknown>; created_at: string }>>(`/admin/media-pipeline/runs?${new URLSearchParams(params as Record<string, string>)}`),
  processMedia: () => apiClient.post<{ processed: number }>("/admin/media-pipeline/process", {}),
  reviewPhotos: (id: string) => apiClient.get<Items<{ fileId: string; dataUrl: string }>>(`/admin/reviews/${id}/photos`),
  createComposable: (payload: { code: string; title: string; composition: unknown[]; variants?: string[]; presets?: string[] }) => apiClient.post<{ id: string }>("/admin/cms/components/composable", payload),
  deleteComponent: (id: string) => apiClient.del(`/admin/cms/components/${id}`),
  pages: (params: {search?:string;limit?:number;offset?:number}={}) => apiClient.get<Items<Record<string, unknown> & { id: string; code: string; title: string; path: string; status: string; page_type: string; section_count: number; version: number; scheduled_start_at: string | null; scheduled_end_at: string | null }> & {total:number}>(`/admin/cms/pages?${new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)]))}`),
  createLanding: (payload: { code: string; title: string; path: string; pageType: string; template: string; description?: string; campaignId?: string | null }) => apiClient.post<{ id: string }>("/admin/cms/landing-pages", payload),
  preview: (pageId: string) => apiClient.get<SitePage>(`/admin/cms/pages/${pageId}/preview`),
  publish: (pageId: string, payload: { scheduledStartAt?: string | null; scheduledEndAt?: string | null; changeSummary?: string; expectedRevision?: number } = {}) => apiClient.post<{ status: string; version: number }>(`/admin/cms/pages/${pageId}/publish`, payload),
  unpublish: (pageId: string, archive = false) => apiClient.post<{ status: string }>(`/admin/cms/pages/${pageId}/unpublish`, { archive }),
  versions: (pageId: string) => apiClient.get<Items<{ id: string; version: number; status: string; change_summary: string | null; created_at: string; section_count: number; changed_by_name: string | null }>>(`/admin/cms/pages/${pageId}/versions`),
  restore: (pageId: string, version: number) => apiClient.post(`/admin/cms/pages/${pageId}/versions/${version}/restore`),
  sections: (pageId: string) => apiClient.get<Items<AdminSection>>(`/admin/cms/pages/${pageId}/sections`),
  addSection: (pageId: string, payload: { componentCode: string; title: string; payload: Record<string, unknown>; visible: boolean; presetCode?: string }) => apiClient.post<{ id: string }>(`/admin/cms/pages/${pageId}/sections`, payload),
  updateSection: (id: string, payload: { title?: string; payload?: Record<string, unknown>; visible?: boolean; variant?: string }) => apiClient.patch(`/admin/cms/sections/${id}`, payload),
  deleteSection: (id: string) => apiClient.del(`/admin/cms/sections/${id}`),
  duplicateSection: (id: string) => apiClient.post(`/admin/cms/sections/${id}/duplicate`),
  reorder: (pageId: string, sectionIds: string[]) => apiClient.post(`/admin/cms/pages/${pageId}/sections/reorder`, { sectionIds }),
  presentation: (id: string, payload: Record<string, unknown>) => apiClient.patch(`/admin/cms/sections/${id}/presentation`, payload),
  cardTemplates: () => apiClient.get<Items<{ id: string; code: string; name: string; variant: string; blocks: string[]; styles: Record<string, unknown>; quality_report: { passed?: boolean; checks?: Record<string, boolean> }; is_system: boolean; active: boolean }>>("/admin/cms/card-templates"),
  createCardTemplate: (payload: Record<string, unknown>) => apiClient.post<{ id: string; qualityReport: { passed: boolean; checks: Record<string, boolean> }; active: boolean }>("/admin/cms/card-templates", payload),
  updateCardTemplate: (id: string, payload: Record<string, unknown>) => apiClient.patch<{ ok: boolean; qualityReport: { passed: boolean; checks: Record<string, boolean> } }>(`/admin/cms/card-templates/${id}`, payload),
  qualityCheck: (payload: { blocks: string[]; styles: Record<string, unknown> }) => apiClient.post<{ passed: boolean; checks: Record<string, boolean>; contrast: number }>("/admin/cms/card-templates/quality-check", payload),
  cardRules: () => apiClient.get<Items<{ id: string; name: string; priority: number; conditions: Record<string, unknown>; template_code: string; active: boolean; starts_at: string | null; ends_at: string | null }>>("/admin/cms/card-rules"),
  createCardRule: (payload: Record<string, unknown>) => apiClient.post("/admin/cms/card-rules", payload),
  updateCardRule: (id: string, payload: Record<string, unknown>) => apiClient.patch(`/admin/cms/card-rules/${id}`, payload),
  deleteCardRule: (id: string) => apiClient.del(`/admin/cms/card-rules/${id}`),
  taxonomy: (kind: "categories" | "vibes") => apiClient.get<Items<Record<string, unknown> & { id: string; name: string; slug: string; description: string; active: boolean; position: number; product_count: number }>>(`/admin/cms/${kind}`),
  createTaxonomy: (kind: "categories" | "vibes", payload: Record<string, unknown>) => apiClient.post(`/admin/cms/${kind}`, payload),
  updateTaxonomy: (kind: "categories" | "vibes", id: string, payload: Record<string, unknown>) => apiClient.patch(`/admin/cms/${kind}/${id}`, payload),
  publicCoupons: () => apiClient.get<Items<{ id: string; code: string; campaign_name: string; type: string; value: string; recipient_user_id: string | null; ends_at: string | null; active: boolean }>>("/admin/coupons?active=true&limit=100"),
  collections: () => apiClient.get<Items<{ id: string; code: string; title: string; mode: string; query_rules: Record<string, unknown>; product_ids: string[]; active: boolean }>>("/admin/cms/collections"),
  createCollection: (payload: Record<string, unknown>) => apiClient.post("/admin/cms/collections", payload),
  updateCollection: (id: string, payload: Record<string, unknown>) => apiClient.patch(`/admin/cms/collections/${id}`, payload),
  previewCollection: (payload: Record<string, unknown>) => apiClient.post<{ items: CommerceProduct[]; count: number }>("/admin/cms/collections/preview", payload),
  themes: () => apiClient.get<{ items: (SiteTheme & { is_preset: boolean; campaign_id: string | null; campaign_name: string | null; activations: { id: string; mode: string; startsAt: string; endsAt: string | null; active: boolean }[] })[]; tokenKeys: string[] }>("/admin/cms/themes"),
  createTheme: (payload: Record<string, unknown>) => apiClient.post<{ id: string; contrast: { bodyContrast: number } }>("/admin/cms/themes", payload),
  activateTheme: (id: string, payload: { mode: "manual" | "scheduled"; startsAt?: string; endsAt?: string | null }) => apiClient.post(`/admin/cms/themes/${id}/activate`, payload),
  bindThemeCampaign: (id: string, campaignId: string | null) => apiClient.patch(`/admin/cms/themes/${id}/campaign`, { campaignId }),
  assets: (params: Record<string, string> = {}) => apiClient.get<Items<{ id: string; title: string; asset_type: string; url: string; folder: string; tags: string[]; alt_text: string; size_bytes: number; created_at: string; uploader_name: string | null; uploaded_by: string | null; pipeline: { status: string; metadata: Record<string, unknown> } | null }> & { uploaders: { id: string; display_name: string }[] }>(`/admin/cms/assets?${new URLSearchParams(params)}`),
  createAsset: (payload: Record<string, unknown>) => apiClient.post<{ id: string; url: string }>("/admin/cms/assets", payload),
  assetUsage: (id: string) => apiClient.get<Items<{ type: string; id: string; label: string }>>(`/admin/cms/assets/${id}/usage`),
  deleteAsset: (id: string, force = false) => apiClient.del(`/admin/cms/assets/${id}${force ? "?force=true" : ""}`),
  announcements: () => apiClient.get<Items<Announcement & { active: boolean; starts_at: string | null; ends_at: string | null; binding_type: string; binding_id: string | null }>>("/admin/cms/announcements"),
  createAnnouncement: (payload: Record<string, unknown>) => apiClient.post("/admin/cms/announcements", payload),
  updateAnnouncement: (id: string, payload: Record<string, unknown>) => apiClient.patch(`/admin/cms/announcements/${id}`, payload),
  deleteAnnouncement: (id: string) => apiClient.del(`/admin/cms/announcements/${id}`),
  layout: () => apiClient.get<{ header: HeaderConfig; footer: FooterConfig; accountAppearance: AccountAppearance }>("/admin/cms/layout"),
  saveLayout: (key: "global_header" | "global_footer" | "account_appearance", value: unknown) => apiClient.put(`/admin/cms/layout/${key}`, value),
  search: (q: string) => apiClient.get<Items<{ id: string; code: string; title: string; kind: string }>>(`/admin/cms/search?q=${encodeURIComponent(q)}`),
  leads: () => apiClient.get<Items<{ id: string; page_code: string; full_name: string | null; phone: string | null; email: string | null; campaign_source: string | null; created_at: string }>>("/admin/cms/leads"),
  analytics: () => apiClient.get<Items<{ event_type: string; component_code: string | null; page_code: string | null; total: number }>>("/admin/cms/analytics"),
  festivals: () => apiClient.get<Items<{ id: string; code: string; name: string; starts_at: string; ends_at: string; active: boolean; discount_percent?: string | number | null }>>("/admin/festivals"),
  styleMatrix: () => apiClient.get<{ items: { category_a: string; category_b: string; compatible: boolean; score_weight: number; reason: string }[]; categories: string[] }>("/admin/style/matrix"),
  saveMatrix: (payload: { categoryA: string; categoryB: string; compatible: boolean; scoreWeight: number; reason?: string }) => apiClient.put("/admin/style/matrix", payload),
  analyzeProduct: (productId: string) => apiClient.post<{ features: StyleFeatures }>(`/admin/style/analyze/${productId}`),
  analyzePending: () => apiClient.post<{ processed: number }>("/admin/style/analyze-pending"),
  supplierChanges: (status?: string) => apiClient.get<Items<{ id: string; user_id: string; brand_name: string; display_name: string; phone: string | null; diff: SupplierDiff[]; status: string; supplier_note: string | null; review_note: string | null; created_at: string }>>(`/admin/supplier-change-requests${status ? `?status=${status}` : ""}`),
  reviewSupplierChange: (id: string, decision: "approved" | "rejected", note?: string) => apiClient.post(`/admin/supplier-change-requests/${id}/review`, { decision, note }),
  reviews: (status?: string) => apiClient.get<Items<{ id: string; product_name: string; display_name: string; rating: number; title: string; body: string; status: string; verified_purchase: boolean; created_at: string; photo_file_ids?: string[] }>>(`/admin/reviews${status ? `?status=${status}` : ""}`),
  moderateReview: (id: string, status: "approved" | "rejected") => apiClient.patch(`/admin/reviews/${id}`, { status }),
};
