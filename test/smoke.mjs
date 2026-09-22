/*
 * Дымовой прогон собранного файла в поддельном браузере.
 *
 *   node test/smoke.mjs
 *
 * Поднимаем jsdom, подставляем вместо НСИС заглушку, которая отдаёт журнал
 * обращений и собранный на месте PDF, и проверяем, что панель появилась, а
 * ответ прошёл весь путь: скачан, разобран, назван, записан в журнал.
 *
 * Это не замена проверке на живом сайте — CSP, УКЭП и доступ к папкам
 * здесь не воспроизводятся, — но ловит поломки сборки и логики.
 */
import fs from 'fs';
import zlib from 'zlib';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const bundle = fs.readFileSync(new URL('../dist/nsis.js', import.meta.url), 'utf8');

/* PDF-ответ, собранный тем же способом, что в test/run.mjs */
function buildPdf(lines) {
  const chars = [...new Set(lines.join('').split(''))].filter((c) => c !== ' ');
  const code = new Map(chars.map((c, i) => [c, i + 1]));
  const hex = (n) => n.toString(16).padStart(4, '0').toUpperCase();
  const cmap = `begincmap\n${chars.length} beginbfchar\n${chars
    .map((c) => `<${hex(code.get(c))}> <${hex(c.charCodeAt(0))}>`)
    .join('\n')}\nendbfchar\nendcmap`;
  const show = (line) =>
    '[' + line.split(' ').map((w) => '<' + [...w].map((c) => hex(code.get(c))).join('') + '>').join(' -250 ') + '] TJ';
  const content = `BT /F1 11 Tf 40 800 Td\n${lines.map((l) => `${show(l)} T*`).join('\n')}\nET`;
  const stream = (data) => {
    const bytes = zlib.deflateSync(Buffer.from(data, 'latin1'));
    return `<</Filter/FlateDecode/Length ${bytes.length}>>\nstream\n${bytes.toString('latin1')}\nendstream`;
  };
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 6 0 R>>',
    '<</Type/Font/Subtype/Type0/BaseFont/Test/ToUnicode 5 0 R>>',
    stream(cmap),
    stream(content),
  ];
  let out = '%PDF-1.7\n';
  objs.forEach((b, i) => (out += `${i + 1} 0 obj\n${b}\nendobj\n`));
  return Buffer.from(out + 'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
}

const PDF = buildPdf([
  'Щенников Алексей Дмитриевич',
  'Email: test@example.com',
  '№ Дела: А50-26151/2025',
  '(далее – АО «НСИС») в ответ на запрос в отношении Борцов Николай Валерьевич сообщает',
  'следующее.',
  'По состоянию на 15.09.2026 в АИС страхования имеется информация',
]);

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lk.nsis.ru/requestLog/',
  pretendToBeVisual: true,
});

const downloads = [];
const calls = [];

global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.location = dom.window.location;
global.alert = () => {};
dom.window.App = { apiUrl: 'https://bff.nsis.ru' };
dom.window.URL.createObjectURL = () => 'blob:stub';
dom.window.URL.revokeObjectURL = () => {};
dom.window.HTMLAnchorElement.prototype.click = function () {
  downloads.push(this.download);
};
global.fetch = async (url) => {
  calls.push(String(url));
  const u = new URL(url);
  if (u.pathname.endsWith('/bff/profile')) {
    return new Response(JSON.stringify({ lastName: 'Щенников', firstName: 'Алексей', middleName: 'Дмитриевич' }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  if (u.pathname.endsWith('/request-log')) {
    const offset = Number(u.searchParams.get('offset') || 0);
    const queries = offset
      ? []
      : [
          {
            requestId: 'req-1',
            createDate: '2026-09-15T10:01:53+05:00',
            status: { code: 'done' },
            answers: [{ json: { fileId: 'j1', signId: 's1', fileSize: 10 }, pdf: { fileId: 'p1', signId: 's1', fileSize: PDF.length } }],
          },
          { requestId: 'req-2', createDate: '2026-09-14T10:00:00+05:00', status: { code: 'in_progress' }, answers: [] },
        ];
    return new Response(JSON.stringify({ queries }), { headers: { 'content-type': 'application/json' } });
  }
  if (u.pathname.endsWith('/insurance-history/pdf')) {
    return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
  }
  return new Response('not found', { status: 404 });
};

let failed = 0;
const ok = (name, cond, extra) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`);
  if (!cond) {
    failed++;
    if (extra !== undefined) console.log('        ', extra);
  }
};

new Function(bundle)();

const app = dom.window.__nsisAuto;
ok('панель смонтирована', !!dom.window.document.getElementById('nsis-auto-panel'));
ok('ядро доступно', !!app && !!app.core);

// ждём, пока проверка отработает
for (let i = 0; i < 100 && (!app.core.state.entries.length || app.core.state.busy); i++) {
  await new Promise((r) => setTimeout(r, 50));
}
app.core.stopAuto(true);

const entry = app.core.state.entries[0];
ok('ответ обработан', !!entry, app.core.state);
if (entry) {
  ok('статус «скачано»', entry.status === 'saved', entry.status);
  ok('ФИО из PDF', JSON.stringify(entry.fio) === JSON.stringify(['Борцов Николай Валерьевич']), entry.fio);
  ok('номер дела из PDF', entry.caseNo === 'А50-26151/2025', entry.caseNo);
  ok('ФУ определён', entry.manager === 'Щенников Алексей Дмитриевич', entry.manager);
  ok('hash посчитан', /^[0-9a-f]{64}$/.test(entry.hash || ''), entry.hash);
  ok('имя файла с ФИО и делом', /^Борцов Николай Валерьевич — А50-26151-2025 — /.test(entry.fileName || ''), entry.fileName);
}
ok('незавершённое обращение пропущено', app.core.state.entries.length === 1, app.core.state.entries.map((e) => e.requestId));
ok('файл отдан на загрузку (папки в jsdom нет)', downloads.length === 1, downloads);
ok('статус НСИС — в порядке', app.core.state.nsis === 'ok', app.core.state.nsis);

const shadow = dom.window.document.getElementById('nsis-auto-panel').shadowRoot.innerHTML;
ok('панель показывает ФУ', shadow.includes('Щенников Алексей Дмитриевич'));
ok('панель показывает должника', shadow.includes('Борцов Николай Валерьевич'));
ok('панель показывает кнопку проверки', shadow.includes('Проверить сейчас'));
ok('панель предупреждает про папку', shadow.includes('Запись в папку недоступна'));

// повторная проверка не должна скачивать то же ещё раз
const before = calls.filter((c) => c.includes('insurance-history/pdf')).length;
await app.core.checkNow();
const after = calls.filter((c) => c.includes('insurance-history/pdf')).length;
ok('обработанный ответ повторно не скачивается', before === after, { before, after });

// сессия истекла
global.fetch = async () => new Response('login', { status: 401 });
await app.core.checkNow();
ok('истёкшая сессия распознана', app.core.state.nsis === 'session', app.core.state.nsis);
ok(
  'панель просит войти по УКЭП',
  dom.window.document.getElementById('nsis-auto-panel').shadowRoot.innerHTML.includes('Сессия НСИС истекла')
);

console.log(failed ? `\n${failed} проверок не прошло` : '\nвсе проверки прошли');
process.exit(failed ? 1 : 0);
