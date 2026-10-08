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
/*
 * Настройки. Адрес кабинета здесь же: так его можно подменить в проверках и
 * поправить, если НСИС однажды переедет, не трогая код.
 *
 * batch и parallel — разные вещи, и их легко перепутать. batch отвечает на
 * вопрос «сколько ответов забрать за одну проверку», parallel — «сколько из
 * них качать одновременно». Осторожный режим — batch 10, parallel 1: НСИС
 * получает по одному запросу за раз. Быстрый — batch 0 (всё, что готово) и
 * parallel 5.
 */
export const DEFAULTS = {
  intervalMin: 15,
  enabled: true,
  api: 'https://bff.nsis.ru',
  batch: 20,
  parallel: 3,
  logLimit: 50,
};

// Границы настроек. Ноль у batch разрешён отдельно и означает «все готовые».
const LIMITS = {
  intervalMin: [1, 240],
  batch: [0, 500],
  parallel: [1, 8],
  logLimit: [10, 500],
};

/** Числа из настроек приводим к целым в разумных границах: поле ввода врёт. */
export function clampSettings(raw) {
  const out = { ...DEFAULTS, ...(raw || {}) };
  for (const key of Object.keys(LIMITS)) {
    const [lo, hi] = LIMITS[key];
    const n = Math.round(Number(out[key]));
    out[key] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[key];
  }
  return out;
}

/**
 * Очередь с ограниченной шириной: запускаем не больше width задач сразу,
 * освободившийся работник берёт следующую. Результат — массив признаков
 * успеха в исходном порядке, чтобы порядок скачанного не зависел от того,
 * какой файл пришёл раньше.
 */
export async function pool(items, width, work) {
  const done = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      try {
        await work(items[i]);
        done[i] = true;
      } catch (e) {
        done[i] = false;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, width), items.length) }, worker));
  return done;
}

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
export async function checkOnce({ fetchImpl, download, state, settings, now = () => new Date() }) {
  const cfg = clampSettings(settings);
  const api = cfg.api;
  const done = state.done || [];
  let queries;
  try {
    const resp = await fetchImpl(
      `${api}/bff/bff-query-log/request-log?limit=${cfg.logLimit}&offset=0&sortDirection=desc`,
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

  const ready = pending(queries, done);
  // batch = 0 означает «забрать всё готовое»; остальное подождёт следующей
  // проверки, и сколько именно — видно в окне расширения.
  const todo = cfg.batch > 0 ? ready.slice(0, cfg.batch) : ready;
  const left = ready.length - todo.length;

  const got = await pool(todo, cfg.parallel, (item) =>
    download({ url: pdfUrl(item.pdf, api), filename: `${SUBDIR}/nsis-${item.id}.pdf`, conflictAction: 'uniquify' })
  );
  // Помечаем обработанными в исходном порядке, а не в порядке завершения.
  todo.forEach((item, i) => {
    if (got[i]) done.push(item.id);
  });
  const saved = got.filter(Boolean).length;
  const failed = got.length - saved;

  return {
    ...state,
    status: 'ok',
    error: failed ? `не удалось скачать: ${failed}` : null,
    done: done.slice(-3000),
    saved: (state.saved || 0) + saved,
    lastSaved: saved,
    left,
    seen: queries.length,
    checkedAt: now().toISOString(),
  };
}

/* ---------------- подключение к браузеру ---------------- */

const hasChrome = typeof chrome !== 'undefined' && chrome.storage;

async function load() {
  const got = await chrome.storage.local.get(['state', 'settings']);
  return { state: got.state || { done: [] }, settings: clampSettings(got.settings) };
}

/* Сохранить настройки и сразу применить то, что меняет расписание. */
async function saveSettings(patch) {
  const { settings } = await load();
  const next = clampSettings({ ...settings, ...(patch || {}) });
  await chrome.storage.local.set({ settings: next });
  chrome.alarms.create('check', { periodInMinutes: next.intervalMin });
  return next;
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
  const next = await checkOnce({ fetchImpl: fetch, download: downloadViaChrome, state, settings });
  await chrome.storage.local.set({ state: next });
  const badge = next.status === 'ok' ? (next.lastSaved ? String(next.lastSaved) : '') : '!';
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color: next.status === 'ok' ? '#3A4027' : '#8D321F' });
  return next;
}

if (hasChrome) {
  chrome.runtime.onInstalled.addListener(async () => {
    const { settings } = await load();
    chrome.alarms.create('check', { periodInMinutes: settings.intervalMin });
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
    if (msg && msg.settings) {
      saveSettings(msg.settings).then(reply);
      return true;
    }
    return false;
  });
  // Имя, которое задало расширение, должно побеждать заголовок сервера.
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (item.byExtensionId === chrome.runtime.id && item.filename) suggest({ filename: item.filename, conflictAction: 'uniquify' });
  });
}
