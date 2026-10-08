import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import LiveApp from "./LiveApp";

// With VITE_CONVEX_URL set (npx convex dev writes it) use the real backend; otherwise the in-browser demo.
const Root = import.meta.env.VITE_CONVEX_URL ? LiveApp : App;

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
