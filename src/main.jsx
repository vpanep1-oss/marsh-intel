import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import FishingTool from "../fishing-tool.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <FishingTool />
  </StrictMode>
);
