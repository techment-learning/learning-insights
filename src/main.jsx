import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "stretch", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 1100 }}>
        <App />
      </div>
    </div>
  </React.StrictMode>
);
