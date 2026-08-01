import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import "@shared/base.css";
import "./index.css";
import { PersonaProvider } from "@shared/PersonaContext.js";
import App from "./App.js";
import Today from "./pages/Today.js";
import { OPS_NAV, findNavItem } from "./nav.js";

/**
 * Screens still to migrate here render a labelled placeholder that names what
 * will live at the route. A blank page in a demonstration reads as a bug; an
 * explicit "not yet built" reads as scope.
 */
function PendingRoute(): JSX.Element {
  const { pathname } = useLocation();
  const item = findNavItem(pathname);
  return (
    <div className="space-y-3 max-w-3xl">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">{item?.label ?? "Screen"}</h1>
        <span className="badge badge-warn">Not yet migrated</span>
      </div>
      <div className="panel p-4 text-op-inkDim leading-relaxed">{item?.note ?? "This screen has not been built."}</div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PersonaProvider portal="ops">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Today />} />
            {OPS_NAV.flatMap((g) => g.items).map((item) => (
              <Route key={item.to} path={item.to.slice(1)} element={<PendingRoute />} />
            ))}
          </Route>
        </Routes>
      </BrowserRouter>
    </PersonaProvider>
  </React.StrictMode>,
);
