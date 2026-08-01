import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import App from "./App.js";
import CitizenPayment from "./pages/CitizenPayment.js";
import Receipt from "./pages/Receipt.js";
import Verify from "./pages/Verify.js";
import BreakRegister from "./pages/BreakRegister.js";
import InstrumentRegister from "./pages/InstrumentRegister.js";
import AgencyDashboard from "./pages/AgencyDashboard.js";
import ControlAssertions from "./pages/ControlAssertions.js";
import PaymentSearch from "./pages/PaymentSearch.js";
import AssessmentExplorer from "./pages/AssessmentExplorer.js";
import PayerExplorer from "./pages/PayerExplorer.js";
import UnappliedQueue from "./pages/UnappliedQueue.js";
import UncertainQueue from "./pages/UncertainQueue.js";
import Teller from "./pages/Teller.js";
import SettlementSweep from "./pages/SettlementSweep.js";
import ApprovalsInbox from "./pages/ApprovalsInbox.js";
import AgencyConfig from "./pages/AgencyConfig.js";
import ReconConsole from "./pages/ReconConsole.js";
import ReportCentre from "./pages/ReportCentre.js";
import AuditExplorer from "./pages/AuditExplorer.js";
import RequestToPay from "./pages/RequestToPay.js";
import Refunds from "./pages/Refunds.js";
import BulkPayments from "./pages/BulkPayments.js";
import DisputeConsole from "./pages/DisputeConsole.js";
import AgentFloat from "./pages/AgentFloat.js";
import RolesAndPermissions from "./pages/RolesAndPermissions.js";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<CitizenPayment />} />
          <Route path="receipt/:paymentReference" element={<Receipt />} />
          <Route path="verify" element={<Verify />} />
          <Route path="breaks" element={<BreakRegister />} />
          <Route path="instruments" element={<InstrumentRegister />} />
          <Route path="dashboard" element={<AgencyDashboard />} />
          <Route path="controls" element={<ControlAssertions />} />
          <Route path="ops/payments" element={<PaymentSearch />} />
          <Route path="ops/assessments" element={<AssessmentExplorer />} />
          <Route path="ops/payers" element={<PayerExplorer />} />
          <Route path="ops/unapplied" element={<UnappliedQueue />} />
          <Route path="ops/uncertain" element={<UncertainQueue />} />
          <Route path="ops/teller" element={<Teller />} />
          <Route path="ops/settlement" element={<SettlementSweep />} />
          <Route path="ops/approvals" element={<ApprovalsInbox />} />
          <Route path="ops/agencies" element={<AgencyConfig />} />
          <Route path="ops/recon-console" element={<ReconConsole />} />
          <Route path="ops/reports" element={<ReportCentre />} />
          <Route path="ops/audit" element={<AuditExplorer />} />
          <Route path="ops/rtp" element={<RequestToPay />} />
          <Route path="ops/refunds" element={<Refunds />} />
          <Route path="ops/bulk-payments" element={<BulkPayments />} />
          <Route path="ops/disputes" element={<DisputeConsole />} />
          <Route path="ops/agent-float" element={<AgentFloat />} />
          <Route path="ops/roles" element={<RolesAndPermissions />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
