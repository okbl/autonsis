/*
 * Точка входа. Запускается на странице личного кабинета НСИС — закладкой
 * или сниппетом DevTools. Повторный запуск не плодит панели, а показывает
 * уже существующую.
 */

import { Core } from './core.js';
import { UI } from './ui.js';

(async function boot() {
  const host = location.hostname;
  if (!/(^|\.)nsis\.ru$/.test(host)) {
    alert('Запускать нужно на странице личного кабинета НСИС: https://lk.nsis.ru/requestLog/');
    return;
  }
  if (window.__nsisAuto) {
    const panel = document.getElementById('nsis-auto-panel');
    if (panel) panel.scrollIntoView({ block: 'center' });
    else window.__nsisAuto.ui.mount();
    return;
  }
  window.__nsisAuto = { core: Core, ui: UI };
  UI.mount();
  try {
    await Core.start();
  } catch (e) {
    console.error('[НСИС] не удалось запустить', e);
    alert('Не удалось запустить: ' + (e && e.message ? e.message : e));
  }
})();
