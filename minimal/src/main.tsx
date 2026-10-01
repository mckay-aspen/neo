import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme.css";
import "./styles.css";
import { MotionConfig } from "motion/react";
import { TooltipProvider } from "./components/ui/tooltip";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <TooltipProvider delayDuration={350}>
        <App />
      </TooltipProvider>
    </MotionConfig>
  </React.StrictMode>,
);
