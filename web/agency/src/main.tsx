import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "@shared/base.css";
import "./index.css";
import { PersonaProvider } from "@shared/PersonaContext.js";
import App from "./App.js";
import Position from "./pages/Position.js";
import BillsIssued from "./pages/BillsIssued.js";
import BillDetail from "./pages/BillDetail.js";
import IssueBill from "./pages/IssueBill.js";
import RequestToPay from "./pages/RequestToPay.js";
import Treasury from "./pages/Treasury.js";
import Statements from "./pages/Statements.js";
import Products from "./pages/Products.js";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PersonaProvider portal="agency">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Position />} />
            <Route path="assessments" element={<BillsIssued />} />
            <Route path="assessments/:psid" element={<BillDetail />} />
            <Route path="issue" element={<IssueBill />} />
            <Route path="request-to-pay" element={<RequestToPay />} />
            <Route path="treasury" element={<Treasury />} />
            <Route path="reports" element={<Statements />} />
            <Route path="products" element={<Products />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PersonaProvider>
  </React.StrictMode>,
);
