import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "@shared/base.css";
import "./index.css";
import { PersonaProvider } from "@shared/PersonaContext.js";
import App from "./App.js";

function Pending({ title, note }: { title: string; note: string }): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{title}</h1>
        <span className="badge badge-neutral">Not yet built</span>
      </div>
      <div className="slab p-5 text-fd-inkDim leading-relaxed">{note}</div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PersonaProvider portal="field">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route
              index
              element={
                <Pending
                  title="Take a payment"
                  note="Accept cash over the counter against a bill, and print the receipt. The teller captures it on the citizen's behalf — it runs through exactly the same pipeline as every other channel, so nothing about the ledger treats counter cash as a special case."
                />
              }
            />
            <Route
              path="instrument"
              element={
                <Pending
                  title="Lodge a cheque"
                  note="Record a physical instrument handed across the counter — cheque, pay order or demand draft — against a bill. It credits provisionally; the money is not final and can never be swept to treasury until the bank clears it."
                />
              }
            />
            <Route
              path="till"
              element={
                <Pending
                  title="Close the till"
                  note="Count the drawer at the end of a shift and reconcile it against what the platform expects. Any over or short posts to the ledger as a real entry rather than being quietly absorbed. A supervisor, never the teller, approves a reversal."
                />
              }
            />
            <Route
              path="agent"
              element={
                <Pending
                  title="Agent float"
                  note="For a shop or kiosk collecting on the platform's behalf: what has been collected, what has been remitted, and what is still owed to the operator — always derived from the movements, never a cached running balance."
                />
              }
            />
          </Route>
        </Routes>
      </BrowserRouter>
    </PersonaProvider>
  </React.StrictMode>,
);
