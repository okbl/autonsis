/*
 * Клиент личного кабинета НСИС.
 *
 * Все запросы идут точно так же, как их делает сам кабинет: база из
 * window.App.apiUrl (https://bff.nsis.ru), cookie сессии, заголовок
 * X-Requested-With. Никакой своей авторизации здесь нет и быть не может —
 * вход выполняет пользователь по УКЭП, мы лишь пользуемся его сессией.
 */

const PATHS = {
  profile: 'bff/profile',
  requestLog: 'bff/bff-query-log/request-log',
  pdf: 'bff/insurance-history/pdf',
};

/** Ошибка с кодом, который потом превращается в человеческую фразу. */
export function apiError(code, extra = {}) {
  const err = new Error(code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function base() {
  const app = typeof window !== 'undefined' ? window.App : null;
  return (app && app.apiUrl) || 'https://bff.nsis.ru';
}

function url(path, params) {
  const u = new URL(`${base()}/${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
    else u.searchParams.set(k, v);
  }
  return u.toString();
}

async function request(path, params, type) {
  let resp;
  try {
    resp = await fetch(url(path, params), {
      method: 'GET',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
  } catch (e) {
    throw apiError('network', { cause: String(e) });
  }
  if (resp.status === 401 || resp.status === 403) throw apiError('session', { status: resp.status });
  if (!resp.ok) throw apiError('http', { status: resp.status, statusText: resp.statusText });
  if (type === 'blob') return resp.blob();
  try {
    return await resp.json();
  } catch (e) {
    // Кабинет отдаёт HTML страницы входа вместо JSON, когда сессия умерла.
    throw apiError('session', { cause: String(e) });
  }
}

export const Nsis = {
  profile() {
    return request(PATHS.profile, null, 'json');
  },

  /** Журнал обращений: { queries: [...] }. */
  log({ limit = 50, offset = 0 } = {}) {
    return request(PATHS.requestLog, { limit, offset, sortDirection: 'desc' }, 'json');
  },

  answerPdf({ fileId, signId }) {
    return request(PATHS.pdf, { fileId, signId }, 'blob');
  },
};

/** Файл готов — та же проверка, которой пользуется сам кабинет. */
export function isReadyFile(file) {
  return !!file && !!file.fileId && !!file.signId && Number(file.fileSize) > 0;
}

/** Готовый к скачиванию ответ из записи журнала обращений. */
export function answerOf(query) {
  const answers = (query && query.answers) || [];
  for (const answer of answers) {
    if (isReadyFile(answer && answer.pdf)) return answer.pdf;
  }
  return null;
}

export function statusCodeOf(query) {
  return (query && query.status && query.status.code) || '';
}

/** ФИО текущего ФУ из профиля — имена полей у кабинета могут отличаться. */
export function managerName(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const data = profile.data && typeof profile.data === 'object' ? profile.data : profile;
  const parts = [data.lastName, data.firstName, data.middleName].filter(Boolean);
  if (parts.length) return parts.join(' ');
  for (const key of ['fullName', 'fio', 'name', 'displayName', 'login', 'email']) {
    if (typeof data[key] === 'string' && data[key].trim()) return data[key].trim();
  }
  return null;
}
