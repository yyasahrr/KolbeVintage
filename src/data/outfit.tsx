/* KOLBE — Shared Outfit State (Phase 1, Non-Core workstream)
 *
 * THE one outfit state. The guided wizard and the canvas are two views of the
 * same record — there is no "wizard state" and "canvas state":
 *
 *        Shared Outfit State (this file)
 *          ↑           ↑
 *          │           │
 *       Wizard  ⇄   Canvas
 *
 *  - a wizard selection appears on the canvas immediately;
 *  - removing/replacing a piece on the canvas updates the wizard immediately;
 *  - each outfit role holds at most one piece, so replacing a category item
 *    replaces the slot instead of duplicating it;
 *  - a dress occupies the top+bottom slots and both clear when it leaves;
 *  - a separate top or bottom makes a one-piece dress obsolete.
 *
 * The transitions live in the PURE `outfitReducer` (exported, unit-tested);
 * the provider is a thin React shell over it. The draft persists to
 * sessionStorage so a refresh mid-composition keeps the work.
 */
import { createContext, ReactNode, useContext, useEffect, useMemo, useReducer } from "react";
import type { Product } from "./catalog";
import { outfitRoleOf, type OutfitRole, type StyleKey, type OccasionKey, type OutfitSelection } from "./styling";

export type OutfitItem = { productId: string; colorId?: string };

export type OutfitState = {
  style?: StyleKey;
  occasion?: OccasionKey;
  items: Partial<Record<OutfitRole, OutfitItem>>;
};

export const EMPTY_OUTFIT: OutfitState = { items: {} };

export type OutfitAction =
  | { type: "style"; style?: StyleKey }
  | { type: "occasion"; occasion?: OccasionKey }
  | { type: "place"; product: Product; colorId?: string }
  | { type: "replace"; role: OutfitRole; product: Product; colorId?: string }
  | { type: "removeRole"; role: OutfitRole }
  | { type: "removeProduct"; productId: string }
  | { type: "clear" };

/** A dress fills — and later vacates — the dress, top and bottom slots. */
const dressOccupies = (role: OutfitRole): OutfitRole[] => (role === "dress" ? ["dress", "top", "bottom"] : [role]);

export function outfitReducer(state: OutfitState, action: OutfitAction): OutfitState {
  switch (action.type) {
    case "style":
      return { ...state, style: action.style };
    case "occasion":
      return { ...state, occasion: action.occasion };
    case "place":
      return outfitReducer(state, { type: "replace", role: outfitRoleOf(action.product), product: action.product, colorId: action.colorId });
    case "replace": {
      const items = { ...state.items };
      for (const slot of dressOccupies(action.role)) {
        if (slot === action.role) items[slot] = { productId: action.product.id, colorId: action.colorId };
        else delete items[slot];
      }
      /* a separate top or bottom makes a one-piece dress obsolete */
      if (action.role === "top" || action.role === "bottom") delete items.dress;
      return { ...state, items };
    }
    case "removeRole": {
      const items = { ...state.items };
      for (const slot of dressOccupies(action.role)) delete items[slot];
      return { ...state, items };
    }
    case "removeProduct": {
      const items: OutfitState["items"] = {};
      for (const [role, item] of Object.entries(state.items) as [OutfitRole, OutfitItem | undefined][]) {
        if (item && item.productId !== action.productId) items[role] = item;
      }
      return { ...state, items };
    }
    case "clear":
      return EMPTY_OUTFIT;
  }
}

type OutfitActions = {
  setStyle: (style?: StyleKey) => void;
  setOccasion: (occasion?: OccasionKey) => void;
  /** Place a product in its role slot — replaces an existing occupant. */
  placeItem: (product: Product, colorId?: string) => OutfitRole;
  /** Replace exactly one slot (wizard "change this pick" / canvas swap). */
  replaceRole: (role: OutfitRole, product: Product, colorId?: string) => void;
  removeRole: (role: OutfitRole) => void;
  removeProduct: (productId: string) => void;
  clear: () => void;
};

export type OutfitContextValue = OutfitState & OutfitActions;

const Ctx = createContext<OutfitContextValue | null>(null);
const DRAFT_KEY = "kolbe-outfit-v1";

export function OutfitProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(outfitReducer, undefined, (): OutfitState => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as OutfitState;
        if (parsed && typeof parsed === "object" && parsed.items && typeof parsed.items === "object") {
          return { items: parsed.items, style: parsed.style, occasion: parsed.occasion };
        }
      }
    } catch { /* ignore unavailable storage */ }
    return EMPTY_OUTFIT;
  });

  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  }, [state]);

  const value = useMemo<OutfitContextValue>(() => ({
    ...state,
    setStyle: (style) => dispatch({ type: "style", style }),
    setOccasion: (occasion) => dispatch({ type: "occasion", occasion }),
    placeItem: (product, colorId) => {
      const role = outfitRoleOf(product);
      dispatch({ type: "place", product, colorId });
      return role;
    },
    replaceRole: (role, product, colorId) => dispatch({ type: "replace", role, product, colorId }),
    removeRole: (role) => dispatch({ type: "removeRole", role }),
    removeProduct: (productId) => dispatch({ type: "removeProduct", productId }),
    clear: () => dispatch({ type: "clear" }),
  }), [state]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOutfit(): OutfitContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("OutfitProvider missing");
  return ctx;
}

/** Selection map in the shape the styling engine consumes. */
export function selectionOf(outfit: OutfitState): OutfitSelection {
  return outfit.items;
}
