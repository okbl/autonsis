/*
 * Фоновая часть расширения: проверяет журнал обращений НСИС и скачивает
 * готовые ответы.
 *
 * Почему это вообще работает, а страница-приложение так не может: запросы
 * идут от расширения, которому в манифесте явно разрешён один адрес —
 * bff.nsis.ru. Сессия пользователя при этом его же, кабинетная: расширение
 * не видит ни УКЭП, ни паролей и ничего не отправляет наружу.
 *
 * Намеренно маленькое. Файл скачивается под именем «nsis-<обращение>.pdf», а
 * разбор ФИО, имена, раскладку по дням и журнал делает страница-приложение,
 * которая читает папку загрузок. Так расширение остаётся тем, что легко
 * прочитать глазами при согласовании: список обращений, скачивание своих же
 * ответов, больше ничего.
 */

/*
 * Подпапка внутри «Загрузок». Имя латиницей не для красоты: chrome.downloads
 * отвергает имя файла с не-ASCII символами («Invalid filename»), и скачивание
 * просто не начинается. Человеческие имена файлам даёт страница-приложение,
 * когда раскладывает их по папкам за день.
 */
const SUBDIR = 'nsis-inbox';
// Адрес кабинета вынесен в настройки: так его можно подменить в проверках и
// поправить, если НСИС однажды переедет, не трогая код.
const DEFAULTS = { intervalMin: 15, enabled: true, api: 'https://bff.nsis.ru' };

/** Готовый PDF из записи журнала — та же проверка, что у самого кабинета. */
export function answerOf(query) {
  for (const answer of (query && query.answers) || []) {
    const pdf = answer && answer.pdf;
    if (pdf && pdf.fileId && pdf.signId && Number(pdf.fileSize) > 0) return pdf;
  }
  return null;
}

/** Что осталось забрать: готовое и ещё не скачанное. */
export function pending(queries, done) {
  const out = [];
  for (const query of queries || []) {
    const pdf = answerOf(query);
    if (!pdf || done.includes(query.requestId)) continue;
    out.push({ id: query.requestId, pdf });
  }
  return out;
}

export function pdfUrl(pdf, api = DEFAULTS.api) {
  return `${api}/bff/insurance-history/pdf?fileId=${encodeURIComponent(pdf.fileId)}&signId=${encodeURIComponent(pdf.signId)}`;
}

/**
 * Одна проверка. Всё внешнее передаётся аргументами, поэтому логику можно
 * прогнать в тестах без браузера.
 */
export async function checkOnce({ fetchImpl, download, state, api = DEFAULTS.api, now = () => new Date() }) {
  const done = state.done || [];
  let queries;
  try {
    const resp = await fetchImpl(
      `${api}/bff/bff-query-log/request-log?limit=50&offset=0&sortDirection=desc`,
      { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } }
    );
    if (resp.status === 401 || resp.status === 403) {
      return { ...state, status: 'session', checkedAt: now().toISOString() };
    }
    if (!resp.ok) return { ...state, status: 'error', error: `НСИС ответил ${resp.status}`, checkedAt: now().toISOString() };
    const data = await resp.json();
    queries = (data && (data.queries || (data.data && data.data.queries))) || [];
  } catch (e) {
    return { ...state, status: 'offline', error: String((e && e.message) || e), checkedAt: now().toISOString() };
  }

  const todo = pending(queries, done);
  let saved = 0;
  const failed = [];
  for (const item of todo) {
    try {
      await download({ url: pdfUrl(item.pdf, api), filename: `${SUBDIR}/nsis-${item.id}.pdf`, conflictAction: 'uniquify' });
      done.push(item.id);
      saved++;
    } catch (e) {
      failed.push(item.id);
    }
  }

  return {
    ...state,
    status: 'ok',
    error: failed.length ? `не удалось скачать: ${failed.length}` : null,
    done: done.slice(-3000),
    saved: (state.saved || 0) + saved,
    lastSaved: saved,
    seen: queries.length,
    checkedAt: now().toISOString(),
  };
}

/* ---------------- подключение к браузеру ---------------- */

const hasChrome = typeof chrome !== 'undefined' && chrome.storage;

async function load() {
  const got = await chrome.storage.local.get(['state', 'settings']);
  return { state: got.state || { done: [] }, settings: { ...DEFAULTS, ...(got.settings || {}) } };
}

function downloadViaChrome(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (id) => {
      const err = chrome.runtime.lastError;
      if (err || id === undefined) reject(new Error(err ? err.message : 'скачивание не началось'));
      else resolve(id);
    });
  });
}

export async function runCheck() {
  const { state, settings } = await load();
  if (!settings.enabled) return state;
  const next = await checkOnce({ fetchImpl: fetch, download: downloadViaChrome, state, api: settings.api });
  await chrome.storage.local.set({ state: next });
  const badge = next.status === 'ok' ? (next.lastSaved ? String(next.lastSaved) : '') : '!';
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color: next.status === 'ok' ? '#3A4027' : '#8D321F' });
  return next;
}

if (hasChrome) {
  chrome.runtime.onInstalled.addListener(async () => {
    const { settings } = await load();
    chrome.alarms.create('check', { periodInMinutes: Math.max(1, settings.intervalMin) });
    runCheck();
  });
  chrome.runtime.onStartup.addListener(() => runCheck());
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'check') runCheck();
  });
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg === 'check') {
      runCheck().then(reply);
      return true;
    }
    if (msg === 'state') {
      load().then(reply);
      return true;
    }
    return false;
  });
  // Имя, которое задало расширение, должно побеждать заголовок сервера.
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (item.byExtensionId === chrome.runtime.id && item.filename) suggest({ filename: item.filename, conflictAction: 'uniquify' });
  });
}
