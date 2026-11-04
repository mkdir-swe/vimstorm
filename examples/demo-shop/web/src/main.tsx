import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { httpApi } from "./api.ts";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <App api={httpApi} />
  </StrictMode>,
);
