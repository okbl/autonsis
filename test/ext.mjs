/*
 * Логика расширения без браузера: всё внешнее (сеть, скачивание, хранилище)
 * передаётся аргументами, поэтому проверяется обычными вызовами.
 *
 *   node test/ext.mjs
 */
import { pending, answerOf, pdfUrl, checkOnce } from '../extension/background.js';

let failed = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`);
  if (!cond) {
    failed++;
    if (extra !== undefined) console.log('        получено:', JSON.stringify(extra));
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), got);

const ready = { fileId: 'p1', signId: 's1', fileSize: 900 };
const queries = [
  { requestId: 'a', answers: [{ pdf: ready }] },
  { requestId: 'b', answers: [{ pdf: { fileId: 'p2', signId: 's2', fileSize: 0 } }] }, // пустой файл
  { requestId: 'c', answers: [] }, // ответа ещё нет
  { requestId: 'd', answers: [{ pdf: { fileId: 'p4', signId: 's4', fileSize: 10 } }] },
];

eq('готовый файл найден', answerOf(queries[0]), ready);
eq('пустой файл не считается готовым', answerOf(queries[1]), null);
eq('без ответов — нечего брать', answerOf(queries[2]), null);
eq('к загрузке только готовые и новые', pending(queries, ['d']).map((x) => x.id), ['a']);
eq('адрес файла', pdfUrl(ready), 'https://bff.nsis.ru/bff/insurance-history/pdf?fileId=p1&signId=s1');

function stubFetch(status, body) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}

const calls = [];
const download = async (opts) => calls.push(opts);

let state = await checkOnce({ fetchImpl: stubFetch(200, { queries }), download, state: { done: [] } });
eq('статус после успешной проверки', state.status, 'ok');
eq('скачано два ответа', calls.length, 2);
eq('имя файла с идентификатором обращения', calls[0].filename, 'nsis-inbox/nsis-a.pdf');
ok('в имени только ASCII — иначе браузер откажет', /^[\x20-\x7E]+$/.test(calls[0].filename), calls[0].filename);
eq('совпадения имён разводятся браузером', calls[0].conflictAction, 'uniquify');
eq('обработанные запомнены', state.done, ['a', 'd']);
eq('счётчик за проход', state.lastSaved, 2);

calls.length = 0;
state = await checkOnce({ fetchImpl: stubFetch(200, { queries }), download, state });
eq('повторная проверка ничего не качает', calls.length, 0);
eq('счётчик всего не сбросился', state.saved, 2);

calls.length = 0;
const expired = await checkOnce({ fetchImpl: stubFetch(401, null), download, state });
eq('истёкшая сессия распознана', expired.status, 'session');
eq('при истёкшей сессии не качаем', calls.length, 0);
eq('список обработанных не потерян', expired.done, ['a', 'd']);

const offline = await checkOnce({
  fetchImpl: async () => {
    throw new TypeError('Failed to fetch');
  },
  download,
  state,
});
eq('недоступность НСИС распознана', offline.status, 'offline');

// Ответ обёрнут в data — кабинет так тоже умеет
const wrapped = await checkOnce({
  fetchImpl: stubFetch(200, { data: { queries: [{ requestId: 'z', answers: [{ pdf: ready }] }] } }),
  download,
  state: { done: [] },
});
eq('обёртка data разобрана', wrapped.done, ['z']);

// Одна ошибка скачивания не останавливает остальные
calls.length = 0;
let n = 0;
const flaky = async (opts) => {
  if (++n === 1) throw new Error('нет места');
  calls.push(opts);
};
const partial = await checkOnce({ fetchImpl: stubFetch(200, { queries }), download: flaky, state: { done: [] } });
eq('второй файл всё равно скачан', calls.length, 1);
eq('упавший не помечен обработанным', partial.done, ['d']);
ok('о неудаче сказано', /не удалось скачать: 1/.test(partial.error || ''), partial.error);

console.log(failed ? `\n${failed} проверок не прошло` : '\nвсе проверки прошли');
process.exit(failed ? 1 : 0);
