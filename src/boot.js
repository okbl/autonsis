/*
 * Точка входа. Один и тот же файл запускается в двух местах:
 *
 *   — на странице-приложении (в разметке есть #nsis-app) — тогда это рабочее
 *     место: папки, журнал, разбор, раскладка;
 *   — на странице личного кабинета НСИС, куда его приносит закладка или
 *     сниппет DevTools, — тогда это панель поверх кабинета, которая умеет ещё
 *     и забирать ответы сама.
 *
 * Повторный запуск не плодит панели.
 */

import { Core } from './core.js';
import { UI } from './ui.js';

(async function boot() {
  const onNsis = /(^|\.)nsis\.ru$/.test(location.hostname);
  const host = document.getElementById('nsis-app');
  if (!onNsis && !host) {
    alert('Эту закладку нужно нажимать на странице личного кабинета НСИС: https://lk.nsis.ru/requestLog/');
    return;
  }
  const mode = onNsis ? 'panel' : 'page';

  if (window.__nsisAuto) {
    if (!document.getElementById('nsis-auto-panel')) window.__nsisAuto.ui.mount(mode, host);
    return;
  }
  window.__nsisAuto = { core: Core, ui: UI };
  UI.mount(mode, host);

  if (mode === 'page') {
    // Перетаскивание — путь без всяких разрешений: работает даже там, где
    // доступ к папкам закрыт политикой.
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('dragover', stop);
    document.addEventListener('drop', (e) => {
      stop(e);
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        Core.addFiles(e.dataTransfer.files);
      }
    });
  }

  try {
    await Core.start(mode);
    // Со страницы-приложения кабинет, скорее всего, недоступен — но проверим
    // фактом, а не предположением, и скажем честно, что вышло.
    if (mode === 'page') await Core.probeNsis();
  } catch (e) {
    console.error('[НСИС] не удалось запустить', e);
    alert('Не удалось запустить: ' + (e && e.message ? e.message : e));
  }
})();
