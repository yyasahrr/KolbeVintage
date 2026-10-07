import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./storefront.css";
import App from "./App";
import { PreviewFrameApp, isPreviewFrame } from "./components/cms-preview-frame";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isPreviewFrame() ? <PreviewFrameApp /> : <App />}
  </StrictMode>
);
