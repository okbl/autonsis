/*
 * Маленькая закладка «забрать ответы».
 *
 * Зачем отдельно от основной панели: закладка с целым приложением весит
 * больше ста килобайт, и браузер вправе её не принять. Здесь ровно одно дело —
 * скачать готовые ответы из кабинета в папку загрузок. Всё остальное —
 * разбор ФИО, имена, раскладка по дням, журнал — делает страница-приложение,
 * которая эту папку читает.
 *
 * Имя файла — «nsis-<идентификатор обращения>.pdf»: по нему страница узнаёт
 * обращение и не путает ответы между собой. Латиница не случайна: имя с
 * кириллицей браузер при скачивании отбрасывает целиком, и файл становится
 * безымянным «download.pdf».
 *
 * Код живёт отдельным файлом, потому что должен оставаться крошечным: сюда
 * ничего нельзя добавлять «заодно».
 */

export async function grab() {
  const api = (window.App && window.App.apiUrl) || 'https://bff.nsis.ru';
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };
  const get = (path, params) =>
    fetch(`${api}/${path}?${new URLSearchParams(params)}`, { credentials: 'include', headers });

  const KEY = 'nsis-grabbed';
  let done;
  try {
    done = new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
  } catch {
    done = new Set();
  }

  let queries;
  try {
    const resp = await get('bff/bff-query-log/request-log', { limit: 50, offset: 0, sortDirection: 'desc' });
    if (resp.status === 401 || resp.status === 403) throw new Error('Сессия НСИС истекла — войдите по УКЭП и нажмите ещё раз');
    if (!resp.ok) throw new Error('НСИС ответил ошибкой ' + resp.status);
    const data = await resp.json();
    queries = (data && (data.queries || (data.data && data.data.queries))) || [];
  } catch (e) {
    alert('Не получилось получить список обращений.\n\n' + ((e && e.message) || e));
    return;
  }

  const ready = [];
  for (const query of queries) {
    for (const answer of query.answers || []) {
      const pdf = answer && answer.pdf;
      if (!pdf || !pdf.fileId || !pdf.signId || !(Number(pdf.fileSize) > 0)) continue;
      if (!done.has(query.requestId)) ready.push({ id: query.requestId, pdf });
      break;
    }
  }

  if (!ready.length) {
    alert(`Новых готовых ответов нет.\nПросмотрено обращений: ${queries.length}.`);
    return;
  }

  let saved = 0;
  const failed = [];
  for (const item of ready) {
    try {
      const resp = await get('bff/insurance-history/pdf', { fileId: item.pdf.fileId, signId: item.pdf.signId });
      if (!resp.ok) throw new Error(String(resp.status));
      const url = URL.createObjectURL(await resp.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `nsis-${item.id}.pdf`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        link.remove();
      }, 30000);
      done.add(item.id);
      saved++;
      // Браузер спрашивает разрешение на несколько файлов — дадим ему паузу.
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      failed.push(String((e && e.message) || e));
    }
  }

  try {
    localStorage.setItem(KEY, JSON.stringify([...done].slice(-2000)));
  } catch {
    /* приватный режим — просто не запомним, дубликаты отсеет страница */
  }

  alert(
    `Скачано ответов: ${saved}.` +
      (failed.length ? `\nНе удалось: ${failed.length} (${failed.slice(0, 3).join(', ')})` : '') +
      '\n\nТеперь откройте страницу «НСИС — ответы»: она разложит файлы и даст им имена.'
  );
}

grab();
