import React from "react";
import ReactDOM from "react-dom/client";
import { Buffer } from "buffer";
import App from "./App";
import "./index.css";

// Polyfill Buffer for isomorphic-git (requires Node.js Buffer API)
globalThis.Buffer = Buffer;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
