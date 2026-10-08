import { createRoot } from "react-dom/client";
import App from "../src/App";
import { setApiBaseUrl } from "../src/data/admin-api";

/* Non-demo E2E entry: the harness points the app at a REAL backend (embedded
   PostgreSQL + Fastify listening on 127.0.0.1) before React mounts, so every
   fetch below goes over real HTTP. */
const w = window as unknown as { __SMOKE_API_BASE__?: string };
if (w.__SMOKE_API_BASE__) setApiBaseUrl(w.__SMOKE_API_BASE__);

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
