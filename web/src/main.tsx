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
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
