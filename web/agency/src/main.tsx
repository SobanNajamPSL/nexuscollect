import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "@shared/base.css";
import "./index.css";
import { PersonaProvider } from "@shared/PersonaContext.js";
import App from "./App.js";
import Position from "./pages/Position.js";
import { Pending } from "./pages/Pending.js";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PersonaProvider portal="agency">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Position />} />
            <Route
              path="assessments"
              element={
                <Pending
                  title="Bills issued"
                  note="A searchable, filterable list of this agency's own assessments. The platform has no list/search endpoint for assessments yet — only single-PSID lookup — so this screen ships alongside a new one."
                />
              }
            />
            <Route
              path="issue"
              element={
                <Pending
                  title="Issue a bill"
                  note="Raise a new assessment against a product, with head-wise line items that must sum to the assessed amount. The API for this already exists and is tested; only the form is missing."
                />
              }
            />
            <Route
              path="request-to-pay"
              element={
                <Pending
                  title="Request to pay"
                  note="Ask a payer to settle an open bill, addressed by alias, and follow it through its lifecycle. Moving here from the operator console, because the bill and the outreach both belong to the agency."
                />
              }
            />
            <Route
              path="treasury"
              element={
                <Pending
                  title="Treasury & scrolls"
                  note="Your scrolls and their control totals, treasury acknowledgement, and period close with sign-off. Every endpoint behind this screen already exists — including the pre-close checks that block a close while a critical break is open."
                />
              }
            />
            <Route
              path="reports"
              element={
                <Pending
                  title="Statements"
                  note="The subset of the eighteen standard reports an agency actually reads: head-wise collection, settlement and sweep, outstanding ageing, the period statement, and the fiscal-year certificate."
                />
              }
            />
            <Route
              path="products"
              element={
                <Pending
                  title="Products"
                  note="This agency's own collection products and their rules — reference scheme, allocation waterfall, eligible channels, overpayment treatment. Maker-checker gated: a product goes live only once a second user approves it."
                />
              }
            />
          </Route>
        </Routes>
      </BrowserRouter>
    </PersonaProvider>
  </React.StrictMode>,
);
