import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { ErrorBoundary } from "./ErrorBoundary"
import "./index.css"

// Disable pinch-zoom on mobile (iOS Safari ignores meta viewport + touch-action)
document.addEventListener("gesturestart", (e) => e.preventDefault())

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
