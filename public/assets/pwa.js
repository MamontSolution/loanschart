/* Регистрация service worker — включает установку сайта как приложения (PWA).
   Работает только в защищённом контексте: https:// или http://localhost. */
'use strict';
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('Service worker не зарегистрирован:', err.message);
    });
  });
}
