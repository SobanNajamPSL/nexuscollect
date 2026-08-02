import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "@shared/base.css";
import "./index.css";
import { PersonaProvider } from "@shared/PersonaContext.js";
import App from "./App.js";
import TakePayment from "./pages/TakePayment.js";
import LodgeCheque from "./pages/LodgeCheque.js";
import CloseTill from "./pages/CloseTill.js";
import AgentFloat from "./pages/AgentFloat.js";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PersonaProvider portal="field">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<TakePayment />} />
            <Route path="instrument" element={<LodgeCheque />} />
            <Route path="till" element={<CloseTill />} />
            <Route path="agent" element={<AgentFloat />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PersonaProvider>
  </React.StrictMode>,
);
