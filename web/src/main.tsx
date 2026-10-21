import { createRoot } from "react-dom/client";
import { App } from "./App";
import { StoreProvider } from "./store";
import "./styles.css";

createRoot(document.getElementById("app")!).render(
  <StoreProvider>
    <App />
  </StoreProvider>
);
