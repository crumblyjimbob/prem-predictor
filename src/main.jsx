import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { storage } from "./lib/storage";
import PremPredictor from "./PremPredictor.jsx";

// The app persists everything through `window.storage`; wire it to Supabase
// before the first render so `hasStore()` is true from the start.
window.storage = storage;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <PremPredictor />
  </StrictMode>
);
