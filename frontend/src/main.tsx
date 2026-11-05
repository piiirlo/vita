import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import App from "./App.tsx";
import "./App.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

// A data router (rather than <BrowserRouter>) so pages can use useBlocker to warn about
// unsaved changes. App keeps declaring its routes with <Routes>.
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
