import type { ReactNode } from "react";

export type BottomNavItem = { id: string; label: string; icon: ReactNode; active: boolean; onClick: () => void; badge?: number };

/**
 * Floating LIQUID bottom navigation for touch widths (<1024px).
 * Search and cart deliberately stay in the top bar — no duplicated primary actions.
 */
export default function MobileBottomNav({ items }: { items: BottomNavItem[] }) {
  return (
    <nav className="kv-sf-bnav kv-liquid" aria-label="ناوبری سریع">
      {items.map((item) => (
        <button
          key={item.id}
          onClick={item.onClick}
          aria-current={item.active ? "page" : undefined}
          data-active={item.active ? "true" : "false"}
          className="kv-sf-bnav-item"
        >
          <span className="relative">
            {item.icon}
            {!!item.badge && (
              <span
                className="absolute -top-1.5 -start-2 min-w-[16px] rounded-full bg-[var(--kvaf-charcoal)] px-1 text-[9.5px] font-bold leading-4 text-[var(--kvaf-bone)] tabular-nums dark:bg-[var(--kvaf-bone)] dark:text-[var(--kvaf-charcoal)]"
                aria-hidden="true"
              >
                {item.badge > 99 ? "۹۹+" : item.badge.toLocaleString("fa-IR")}
              </span>
            )}
          </span>
          <span className="truncate">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
