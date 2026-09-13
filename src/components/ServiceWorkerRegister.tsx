"use client";

import { useEffect } from "react";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Register after load so it never competes with the initial page/audio setup.
    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Offline caching is a nice-to-have; failing silently is fine here.
      });
    };
    window.addEventListener("load", onLoad);
    return () => window.removeEventListener("load", onLoad);
  }, []);

  return null;
}
