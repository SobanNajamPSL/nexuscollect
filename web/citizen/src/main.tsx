import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "@shared/base.css";
import "./index.css";
import { PersonaProvider } from "@shared/PersonaContext.js";
import App from "./App.js";
import FindBill from "./pages/FindBill.js";
import Receipt from "./pages/Receipt.js";
import Receipts from "./pages/Receipts.js";
import Verify from "./pages/Verify.js";

/**
 * Scope note: this portal is deliberately narrow. The demonstration's audience
 * is a ministry, not a consumer, so the citizen experience is built only to the
 * extent that a payment can genuinely be initiated or completed — enough to make
 * every downstream figure in the agency and operator portals real rather than
 * narrated. Narrow, though, is not the same as unfinished: the receipt is the
 * artefact that outlives the transaction, and it is built to that standard.
 */
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* The provider is still mounted so the harness renders consistently; for
        this portal it resolves to no personas at all, which is the honest
        representation of an unauthenticated public surface. */}
    <PersonaProvider portal="citizen">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<FindBill />} />
            <Route path="receipt/:paymentReference" element={<Receipt />} />
            <Route path="receipts" element={<Receipts />} />
            <Route path="verify" element={<Verify />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PersonaProvider>
  </React.StrictMode>,
);
