// Start-up: create the app, handle "Open with" launches, and register the service worker that makes
// the app installable and usable offline. Updates wait for the user to click Reload.

import { App } from './app.js';
import { $ } from './ui/dom.js';

const app = new App();
window.movieApp = app; // handy for debugging from the console

if ('launchQueue' in window) {
  window.launchQueue.setConsumer((params) => {
    if (params.files && params.files.length) app.openSources(params.files);
  });
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  let reloading = false;
  let userAsked = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userAsked && !reloading) {
      reloading = true;
      location.reload();
    }
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (worker) => {
      if (!worker || !navigator.serviceWorker.controller) return;
      $('#update').hidden = false;
      app.onUpdateReload = () => {
        userAsked = true;
        worker.postMessage({ type: 'skipWaiting' });
      };
    };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
    });
    // check for updates every hour while open
    setInterval(() => reg.update().catch(() => {}), 3600 * 1000);
  }).catch(() => { /* offline support unavailable, the app still works */ });
}
