/*
 * Мост к НСИС со стороннего сайта.
 *
 * Прочитать список обращений наша страница не может: браузер запрещает читать
 * ответы чужого адреса (CORS), и обойти это нельзя. Но переход по ссылке —
 * не чтение: при открытии новой вкладки браузер отправляет куки сессии, и
 * кабинет отвечает как обычно. Отсюда конструкция:
 *
 *   1) страница открывает список обращений во вкладке — вы его видите;
 *   2) вы отдаёте его странице: Ctrl+S в той вкладке (файл попадёт в папку
 *      загрузок, которую страница и так читает) или Ctrl+A, Ctrl+C и «вставить»;
 *   3) страница достаёт из списка готовые ответы и запускает их скачивание
 *      теми же переходами — файлы падают в папку загрузок;
 *   4) дальше обычный путь: разбор ФИО, имена, папки по дням, журнал.
 *
 * Это не обход защиты: все запросы делает сам пользователь своей же сессией,
 * ровно то же самое происходит, когда он нажимает «Скачать» в кабинете.
 */

const API = 'https://bff.nsis.ru';

export const LIST_URL = `${API}/bff/bff-query-log/request-log?limit=50&offset=0&sortDirection=desc`;

export function pdfUrl({ fileId, signId }) {
  return `${API}/bff/insurance-history/pdf?fileId=${encodeURIComponent(fileId)}&signId=${encodeURIComponent(signId)}`;
}

/** Похоже ли содержимое файла на список обращений НСИС. */
export function looksLikeLog(text) {
  return /"queries"\s*:/.test(String(text || ''));
}

/**
 * Список обращений (текстом, как его отдаёт кабинет) → готовые ответы.
 * @returns {{items: Array<{id: string, fileId: string, signId: string, createDate: string|null}>, seen: number}}
 */
export function parseLog(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('Это не список обращений: не удалось разобрать JSON');
  }
  const queries = (data && (data.queries || (data.data && data.data.queries))) || [];
  if (!Array.isArray(queries)) throw new Error('В ответе нет списка обращений');

  const items = [];
  for (const query of queries) {
    for (const answer of query.answers || []) {
      const pdf = answer && answer.pdf;
      if (!pdf || !pdf.fileId || !pdf.signId || !(Number(pdf.fileSize) > 0)) continue;
      items.push({
        id: query.requestId,
        fileId: pdf.fileId,
        signId: pdf.signId,
        createDate: query.createDate || null,
      });
      break;
    }
  }
  return { items, seen: queries.length };
}

/**
 * Запуск скачиваний переходами. Между ними пауза: браузер иначе считает это
 * попыткой завалить его файлами и спрашивает разрешение на каждый.
 * @param {(url: string) => void} open как открывать ссылку (в жизни — window.open)
 */
export async function grab(items, open, pause = 700) {
  let started = 0;
  for (const item of items) {
    open(pdfUrl(item));
    started++;
    if (started < items.length) await new Promise((r) => setTimeout(r, pause));
  }
  return started;
}
