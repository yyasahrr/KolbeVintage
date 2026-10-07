import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * Module-level error boundary for the admin console.
 *
 * A crash inside one module (shipping, WMS, CRM, …) must never blank the whole console:
 * the boundary catches it, keeps the surrounding shell alive and offers a retry,
 * which remounts the crashed subtree.
 */
export class ModuleBoundary extends Component<
  { name: string; children: ReactNode },
  { error: Error | null; attempt: number }
> {
  constructor(props: { name: string; children: ReactNode }) {
    super(props);
    this.state = { error: null, attempt: 0 };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console is the dev-visible channel; production keeps the Persian message for the operator.
    console.error(`[admin:${this.props.name}] module crashed: ${error.message}`, error, info.componentStack);
  }

  private retry = () => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));

  render() {
    const { error } = this.state;
    if (!error) {
      return <div key={this.state.attempt}>{this.props.children}</div>;
    }
    return (
      <div role="alert" className="rounded-[16px] border border-[var(--kv-danger)]/40 bg-[var(--kv-surface)] p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[var(--kv-danger)]/10 text-[var(--kv-danger)]">
            <AlertTriangle size={19} />
          </span>
          <div className="min-w-0">
            <p className="text-[14px] font-extrabold">خطایی در این بخش رخ داد</p>
            <p className="mt-1 text-[12.5px] leading-6 text-[var(--kv-muted)]">
              بخش «{this.props.name}» بارگذاری نشد؛ بقیه کنسول سالم است. می‌توانید دوباره تلاش کنید.
            </p>
            {import.meta.env.DEV && (
              <pre dir="ltr" className="kv-scroll mt-3 max-h-40 overflow-auto rounded-[10px] bg-[var(--kv-surface-2)] p-3 text-left text-[11px] leading-5 text-[var(--kv-danger)]">
                {error.message}
                {error.stack ? `\n${error.stack.split("\n").slice(1, 4).join("\n")}` : ""}
              </pre>
            )}
            <button
              type="button"
              onClick={this.retry}
              className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg bg-[var(--kv-action)] px-4 text-[13px] font-bold text-[var(--kv-bg)] dark:text-[#0E1527]"
            >
              <RefreshCw size={14} /> تلاش مجدد
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/** Small helper so modules can be wrapped without repeating the prop name twice. */
export const moduleBoundary = (name: string, node: ReactNode) => <ModuleBoundary name={name}>{node}</ModuleBoundary>;
