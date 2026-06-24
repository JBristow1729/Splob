import { createApp } from "./ui/app.js";

createApp(document.querySelector("#app"));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
  });
}
