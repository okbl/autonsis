/*
 * Логика расширения без браузера: всё внешнее (сеть, скачивание, хранилище)
 * передаётся аргументами, поэтому проверяется обычными вызовами.
 *
 *   node test/ext.mjs
 */
import { pending, answerOf, pdfUrl, checkOnce, clampSettings, pool, DEFAULTS } from '../extension/background.js';

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

/* ---------------- сколько скачивать ---------------- */

eq('по умолчанию берём партию', clampSettings().batch, 20);
eq('ноль у партии разрешён — это «всё»', clampSettings({ batch: 0 }).batch, 0);
eq('отрицательная партия подтянута к нулю', clampSettings({ batch: -5 }).batch, 0);
eq('слишком большая партия обрезана', clampSettings({ batch: 9000 }).batch, 500);
eq('дробное округляется', clampSettings({ parallel: 2.6 }).parallel, 3);
eq('ноль одновременных — это один', clampSettings({ parallel: 0 }).parallel, 1);
eq('больше восьми одновременно не даём', clampSettings({ parallel: 99 }).parallel, 8);
eq('мусор вместо числа — значение по умолчанию', clampSettings({ intervalMin: 'каждые полчаса' }).intervalMin, DEFAULTS.intervalMin);
eq('адрес кабинета не трогаем', clampSettings({ api: 'https://x' }).api, 'https://x');

// Очередь: ширина соблюдается, порядок результата — исходный
let running = 0;
let peak = 0;
const order = [];
const got = await pool([1, 2, 3, 4, 5, 6], 2, async (n) => {
  peak = Math.max(peak, ++running);
  await new Promise((r) => setTimeout(r, n === 1 ? 20 : 1));
  order.push(n);
  running--;
  if (n === 3) throw new Error('не вышло');
});
eq('одновременно не больше заданного', peak, 2);
eq('успехи и неудачи в исходном порядке', got, [true, true, false, true, true, true]);
ok('порядок завершения мог отличаться от исходного', order[0] !== 1, order);

const many = Array.from({ length: 7 }, (_, i) => ({
  requestId: `q${i}`,
  answers: [{ pdf: { fileId: `f${i}`, signId: `s${i}`, fileSize: 10 } }],
}));

calls.length = 0;
let batched = await checkOnce({
  fetchImpl: stubFetch(200, { queries: many }),
  download,
  state: { done: [] },
  settings: { batch: 3, parallel: 2 },
});
eq('за проверку взяли ровно партию', calls.length, 3);
eq('взяли первые по порядку журнала', batched.done, ['q0', 'q1', 'q2']);
eq('остаток посчитан', batched.left, 4);

calls.length = 0;
batched = await checkOnce({
  fetchImpl: stubFetch(200, { queries: many }),
  download,
  state: batched,
  settings: { batch: 3, parallel: 2 },
});
eq('следующая проверка берёт следующих', batched.done.slice(-3), ['q3', 'q4', 'q5']);
eq('остался один', batched.left, 1);

calls.length = 0;
const all = await checkOnce({
  fetchImpl: stubFetch(200, { queries: many }),
  download,
  state: { done: [] },
  settings: { batch: 0 },
});
eq('ноль означает «все готовые»', calls.length, 7);
eq('остатка нет', all.left, 0);

let asked = '';
await checkOnce({
  fetchImpl: async (url) => {
    asked = url;
    return { status: 200, ok: true, json: async () => ({ queries: [] }) };
  },
  download,
  state: { done: [] },
  settings: { logLimit: 200 },
});
ok('глубина журнала уходит в запрос', /limit=200/.test(asked), asked);

console.log(failed ? `\n${failed} проверок не прошло` : '\nвсе проверки прошли');
process.exit(failed ? 1 : 0);
