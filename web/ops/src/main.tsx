import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "@shared/base.css";
import "./index.css";
import { PersonaProvider } from "@shared/PersonaContext.js";
import App from "./App.js";
import Today from "./pages/Today.js";
import Payments from "./pages/Payments.js";
import Payers from "./pages/Payers.js";
import Assessments from "./pages/Assessments.js";
import Uncertain from "./pages/Uncertain.js";
import Unapplied from "./pages/Unapplied.js";
import ReconRuns from "./pages/ReconRuns.js";
import Breaks from "./pages/Breaks.js";
import Refunds from "./pages/Refunds.js";
import Disputes from "./pages/Disputes.js";
import Approvals from "./pages/Approvals.js";
import Instruments from "./pages/Instruments.js";
import Sweep from "./pages/Sweep.js";
import Bulk from "./pages/Bulk.js";
import Controls from "./pages/Controls.js";
import Audit from "./pages/Audit.js";
import Overview from "./pages/Overview.js";
import Reports from "./pages/Reports.js";
import Roles from "./pages/Roles.js";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PersonaProvider portal="ops">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Today />} />
            <Route path="payments" element={<Payments />} />
            <Route path="payers" element={<Payers />} />
            <Route path="assessments" element={<Assessments />} />
            <Route path="uncertain" element={<Uncertain />} />
            <Route path="unapplied" element={<Unapplied />} />
            <Route path="recon" element={<ReconRuns />} />
            <Route path="breaks" element={<Breaks />} />
            <Route path="refunds" element={<Refunds />} />
            <Route path="disputes" element={<Disputes />} />
            <Route path="approvals" element={<Approvals />} />
            <Route path="instruments" element={<Instruments />} />
            <Route path="sweep" element={<Sweep />} />
            <Route path="bulk" element={<Bulk />} />
            <Route path="controls" element={<Controls />} />
            <Route path="audit" element={<Audit />} />
            <Route path="overview" element={<Overview />} />
            <Route path="reports" element={<Reports />} />
            <Route path="roles" element={<Roles />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PersonaProvider>
  </React.StrictMode>,
);
