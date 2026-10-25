import { createRoot } from "react-dom/client";
import { App } from "./App";
import { StoreProvider } from "./store";
// Шрифты лежат в сборке, а не на Google Fonts: браузеры пользователей никуда, кроме нашего сервера, не обращаются
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";

createRoot(document.getElementById("app")!).render(
  <StoreProvider>
    <App />
  </StoreProvider>
);
