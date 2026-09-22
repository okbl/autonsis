/*
 * Проверки без браузера.
 *
 *   node test/run.mjs                    — синтетические PDF и правила разбора
 *   node test/run.mjs ответ.pdf …        — плюс прогон по настоящим ответам НСИС
 *
 * Настоящие PDF в репозиторий не кладутся: в них персональные данные
 * должников. Поэтому обязательная часть тестов работает на PDF, который
 * собирается здесь же, а живые файлы подаются аргументами.
 */
import fs from 'fs';
import zlib from 'zlib';
import { pdfPagesText } from '../src/pdftext.js';
import { parseAnswer } from '../src/parse.js';
import { fileNameFor, folderForDay, withCopyIndex, sanitize, asciiName } from '../src/name.js';
import { answerOf, isReadyFile, managerName } from '../src/api.js';
import { parseLog, looksLikeLog, pdfUrl, grab } from '../src/bridge.js';

const inflate = async (u8) => new Uint8Array(zlib.inflateSync(Buffer.from(u8)));

let failed = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`);
  if (!cond) {
    failed++;
    if (extra !== undefined) console.log('        получено:', JSON.stringify(extra));
  }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), got);
}

/* ------------------------------------------------------------------ */
/* PDF, собранный на месте: те же приёмы, что в ответах НСИС —         */
/* составной шрифт, шестнадцатеричные строки, пробел смещением.        */

function buildPdf(lines, { compress }) {
  const chars = [...new Set(lines.join('').split(''))].filter((c) => c !== ' ');
  const code = new Map(chars.map((c, i) => [c, i + 1]));
  const hex = (n) => n.toString(16).padStart(4, '0').toUpperCase();

  const bfchar = chars
    .map((c) => `<${hex(code.get(c))}> <${hex(c.charCodeAt(0))}>`)
    .join('\n');
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
${chars.length} beginbfchar
${bfchar}
endbfchar
endcmap
end end`;

  // Пробел набираем отрицательным смещением, как настоящий генератор.
  const show = (line) =>
    '[' +
    line
      .split(' ')
      .map((word) => '<' + [...word].map((c) => hex(code.get(c))).join('') + '>')
      .join(' -250 ') +
    '] TJ';
  const content = `BT /F1 11 Tf 40 800 Td\n${lines.map((l) => `${show(l)} T*`).join('\n')}\nET`;

  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  const stream = (dict, data) => {
    const bytes = compress ? zlib.deflateSync(Buffer.from(data, 'latin1')) : Buffer.from(data, 'latin1');
    const filter = compress ? '/Filter/FlateDecode' : '';
    return `<<${dict}${filter}/Length ${bytes.length}>>\nstream\n${bytes.toString('latin1')}\nendstream`;
  };
  add('<</Type/Catalog/Pages 2 0 R>>');
  add('<</Type/Pages/Kids[3 0 R]/Count 1>>');
  add('<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 6 0 R>>');
  add('<</Type/Font/Subtype/Type0/BaseFont/Test/ToUnicode 5 0 R>>');
  add(stream('', cmap));
  add(stream('', content));

  let out = '%PDF-1.7\n';
  objs.forEach((body, i) => {
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  out += 'trailer<</Root 1 0 R>>\n%%EOF\n';
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

const LETTER = [
  'Петров Пётр Петрович',
  'Email: test@example.com',
  '№ Дела: А50-11111/2024',
  'Акционерное общество «Национальная Страховая Информационная Система»',
  '(далее – АО «НСИС») в ответ на запрос в отношении Сидоров Сидор Сидорович, Сидорова',
  'Мария Ивановна сообщает следующее.',
  'По состоянию на 15.09.2026 в АИС страхования имеется информация',
];
const APPENDIX = [
  'Сведения о договорах страхования ОСАГО',
  'Субъект, в отношении которого запрошена страховая история:',
  'Физическое лицо - Сидоров Сидор Сидорович 15.03.1991 года рождения',
];

for (const compress of [false, true]) {
  const label = compress ? 'сжатый' : 'несжатый';
  const pages = await pdfPagesText(buildPdf(LETTER, { compress }), inflate, 3);
  ok(`${label} PDF: текст прочитан`, pages[0].includes('Сидоров Сидор Сидорович'), pages[0]);
  ok(`${label} PDF: пробелы восстановлены`, pages[0].includes('в ответ на запрос'), pages[0].slice(0, 200));
}

/* ------------------------------------------------------------------ */
/* Разбор письма                                                       */

const parsed = parseAnswer([
  (await pdfPagesText(buildPdf(LETTER, { compress: true }), inflate, 1))[0],
  APPENDIX.join('\n'),
]);
eq('ФИО должников', parsed.fio, ['Сидоров Сидор Сидорович', 'Сидорова Мария Ивановна']);
eq('номер дела', parsed.caseNo, 'А50-11111/2024');
eq('финансовый управляющий', parsed.manager, 'Петров Пётр Петрович');
eq('дата ответа', parsed.answerDate, '15.09.2026');
eq('дата рождения', parsed.birth['Сидоров Сидор Сидорович'], '15.03.1991');

const noFio = parseAnswer(['Какой-то текст без нужных оборотов']);
eq('ФИО не найдено — пустой список', noFio.fio, []);

/* ------------------------------------------------------------------ */
/* Имена файлов и папок                                                */

const when = new Date(2026, 8, 20, 14, 35, 12);
eq('папка за день', folderForDay(when), '20.09.2026');
eq(
  'имя: ФИО, дело, дата-время',
  fileNameFor({ fio: ['Иванов Иван Иванович'], caseNo: 'А50-26151/2025' }, when),
  'Иванов Иван Иванович — А50-26151-2025 — 20.09.2026 14-35-12.pdf'
);
eq(
  'имя без номера дела по настройке',
  fileNameFor({ fio: ['Иванов Иван Иванович'], caseNo: 'А50-26151/2025' }, when, { withCase: false }),
  'Иванов Иван Иванович — 20.09.2026 14-35-12.pdf'
);
eq(
  'несколько должников',
  fileNameFor({ fio: ['Борцов Николай Валерьевич', 'Борцова Любовь Андреевна'], caseNo: null }, when),
  'Борцов Николай Валерьевич и др. — 20.09.2026 14-35-12.pdf'
);
eq('ФИО не определено', fileNameFor({ fio: [], caseNo: null }, when), 'Не определено — 20.09.2026 14-35-12.pdf');
eq('повторная загрузка', withCopyIndex('Файл.pdf', 2), 'Файл (2).pdf');
eq('первая загрузка без индекса', withCopyIndex('Файл.pdf', 0), 'Файл.pdf');
eq('запрещённые символы', sanitize('А50-1/2 *"<>|:?'), 'А50-1-2 -------');
// Браузер выбрасывает имя целиком, если в нём есть не-ASCII, — отсюда латиница.
eq(
  'имя латиницей для обычного скачивания',
  asciiName('Иванов Иван Иванович — А50-26151-2025 — 20.09.2026 14-35-12.pdf'),
  'Ivanov Ivan Ivanovich - A50-26151-2025 - 20.09.2026 14-35-12.pdf'
);
eq('в имени латиницей нет не-ASCII', /^[\x20-\x7E]+$/.test(asciiName('Щёлкин Пётр Юрьевич — 1.pdf')), true);

/* ------------------------------------------------------------------ */
/* Разбор ответа журнала обращений НСИС                                */

const query = {
  requestId: 'abc',
  status: { code: 'done' },
  answers: [{ json: { fileId: 'j', signId: 's', fileSize: 10 }, pdf: { fileId: 'p', signId: 's', fileSize: 20 } }],
};
eq('готовый PDF найден', answerOf(query), { fileId: 'p', signId: 's', fileSize: 20 });
ok('пустой файл не готов', !isReadyFile({ fileId: 'p', signId: 's', fileSize: 0 }));
eq('нет ответов — нет файла', answerOf({ requestId: 'x', answers: [] }), null);
eq('ФУ из профиля', managerName({ lastName: 'Щенников', firstName: 'Алексей', middleName: 'Дмитриевич' }), 'Щенников Алексей Дмитриевич');
eq('ФУ из fullName', managerName({ data: { fullName: 'Иванов И. И.' } }), 'Иванов И. И.');

/* ------------------------------------------------------------------ */
/* Мост: список обращений, сохранённый из кабинета                     */

const logText = JSON.stringify({
  queries: [
    { requestId: 'a', createDate: '2026-09-15T10:00:00+05:00', answers: [{ pdf: { fileId: 'f1', signId: 's1', fileSize: 500 } }] },
    { requestId: 'b', answers: [{ pdf: { fileId: 'f2', signId: 's2', fileSize: 0 } }] },
    { requestId: 'c', answers: [] },
    { requestId: 'd', answers: [{ json: { fileId: 'j', signId: 's', fileSize: 5 }, pdf: { fileId: 'f4', signId: 's4', fileSize: 700 } }] },
  ],
});
ok('список обращений узнаётся по виду', looksLikeLog(logText));
ok('посторонний файл не считается списком', !looksLikeLog('%PDF-1.7 какой-то файл'));
const fromLog = parseLog(logText);
eq('из списка взяты только готовые', fromLog.items.map((x) => x.id), ['a', 'd']);
eq('обращений просмотрено', fromLog.seen, 4);
eq('адрес файла', pdfUrl(fromLog.items[0]), 'https://bff.nsis.ru/bff/insurance-history/pdf?fileId=f1&signId=s1');
eq('обёртка data тоже разбирается', parseLog(JSON.stringify({ data: { queries: [] } })).items, []);
ok('мусор отвергается понятно', await (async () => {
  try { parseLog('не json'); return false; } catch (e) { return /не удалось разобрать JSON/.test(e.message); }
})());
const opened = [];
eq('скачивания запускаются по одному', await grab(fromLog.items, (u) => opened.push(u), 0), 2);
eq('открыты адреса обоих файлов', opened.length, 2);

/* ------------------------------------------------------------------ */
/* Настоящие ответы, если их передали аргументами                      */

for (const file of process.argv.slice(2)) {
  const pages = await pdfPagesText(new Uint8Array(fs.readFileSync(file)), inflate, 4);
  const real = parseAnswer(pages);
  console.log(`\n${file}`);
  console.log('  ФИО   :', real.fio.join(', ') || '— не определено');
  console.log('  ДР    :', JSON.stringify(real.birth));
  console.log('  дело  :', real.caseNo || '—');
  console.log('  ФУ    :', real.manager || '—');
  console.log('  дата  :', real.answerDate || '—');
  console.log('  имя   :', fileNameFor(real, new Date()));
  ok(`${file}: ФИО определено`, real.fio.length > 0);
  ok(`${file}: номер дела определён`, !!real.caseNo);
}

console.log(failed ? `\n${failed} проверок не прошло` : '\nвсе проверки прошли');
process.exit(failed ? 1 : 0);
