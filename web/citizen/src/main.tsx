import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "@shared/base.css";
import "./index.css";
import { PersonaProvider } from "@shared/PersonaContext.js";
import App from "./App.js";

/**
 * Scope note: this portal is deliberately narrow. The demonstration's audience
 * is a ministry, not a consumer, so the citizen experience is built only to the
 * extent that a payment can genuinely be initiated or completed — enough to make
 * every downstream figure in the agency and operator portals real rather than
 * narrated. Narrow, though, is not the same as unfinished.
 */
function Pending({ title, note }: { title: string; note: string }): JSX.Element {
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="card p-4 text-sm text-cz-inkDim leading-relaxed">{note}</div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* The provider is still mounted so the harness renders consistently; for
        this portal it resolves to no personas at all, which is the honest
        representation of an unauthenticated public surface. */}
    <PersonaProvider portal="citizen">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route
              index
              element={
                <Pending
                  title="Find your bill"
                  note="Look up a bill by any reference the payer actually has — PSID, vehicle registration, CNIC, case number, or a scanned QR — and see everything owed across every agency in one list, including anything already paid."
                />
              }
            />
            <Route
              path="receipt/:paymentReference"
              element={
                <Pending
                  title="Receipt"
                  note="The payer's receipt, in English and Urdu, with a head-wise breakdown, the amount in words, and a QR code that can be verified with no network connection."
                />
              }
            />
            <Route
              path="verify"
              element={
                <Pending
                  title="Verify a receipt"
                  note="Anyone holding a receipt can confirm it is genuine and has not since been voided or refunded — no login, and a signature check that works offline."
                />
              }
            />
          </Route>
        </Routes>
      </BrowserRouter>
    </PersonaProvider>
  </React.StrictMode>,
);
