/*
 * Разбор сопроводительного письма ответа НСИС.
 *
 * Чистые функции: на входе текст страниц, на выходе поля. Ни DOM, ни сети,
 * ни файлов — поэтому разбор прогоняется по настоящим PDF в тестах.
 *
 * Что берём и откуда:
 *   ФИО должников  — страница 1, «в ответ на запрос в отношении … сообщает»;
 *   дата рождения  — страница 2 и далее, «Субъект, в отношении которого…»;
 *   номер дела     — страница 1, «№ Дела:»;
 *   ФУ             — страница 1, адресат перед «Email:»;
 *   дата ответа    — страница 1, «По состоянию на».
 *
 * Текст в PDF местами склеен и переносится с дефисом, поэтому все правила
 * работают по «сплющенной» копии: без пробелов и без переносов. Так разбор
 * не зависит от того, насколько удачно восстановились пробелы.
 */

const WORD = '[А-ЯЁ][а-яё]+(?:-[А-ЯЁ]?[а-яё]+)?';

/** Убирает переносы, склеивает всё в одну строку без пробелов. */
function flatten(text) {
  return text
    .replace(/­/g, '')
    .replace(/-\s*\n\s*/g, '')
    .replace(/\s+/g, '');
}

/** «БорцовНиколайВалерьевич» → «Борцов Николай Валерьевич». */
function splitFio(glued) {
  const words = glued.match(new RegExp(WORD, 'g'));
  if (!words || words.length < 2) return null;
  return words.slice(0, 3).join(' ');
}

function parseFioList(glued) {
  return glued
    .split(',')
    .map((part) => splitFio(part))
    .filter(Boolean);
}

/**
 * @param {string[]} pages текст страниц (достаточно первых трёх)
 * @returns {{fio: string[], birth: Object<string,string>, caseNo: string|null,
 *            manager: string|null, answerDate: string|null}}
 */
export function parseAnswer(pages) {
  const flat = pages.map(flatten);
  const head = flat[0] || '';
  const all = flat.join('\n');

  const fio = [];
  const inResponse = /вответназапросвотношении(.+?)сообщает/.exec(head);
  if (inResponse) fio.push(...parseFioList(inResponse[1]));

  // Разделы приложения дают ФИО ещё раз — уже с датой рождения.
  const birth = {};
  const subject = new RegExp(
    `Физическоелицо-?(${WORD}${WORD}${WORD})(\\d{2}\\.\\d{2}\\.\\d{4})?годарождения`,
    'g'
  );
  let m;
  while ((m = subject.exec(all))) {
    const name = splitFio(m[1]);
    if (!name) continue;
    if (m[2]) birth[name] = m[2];
    if (!fio.includes(name)) fio.push(name);
  }

  // Номер дела чаще всего «А50-26151/2025», но бывает и «2-123/2024».
  // Сначала строгая форма, потом — всё до начала следующего слова с заглавной.
  const caseNo =
    /№Дела:\s*([А-ЯA-Z]{0,2}\d{1,3}-\d{1,8}\/\d{2,4})/.exec(head) ||
    /№Дела:\s*([^\s№]{1,40}?)(?=[А-ЯЁ][а-яё]{3}|№|$)/.exec(head);
  const manager = new RegExp(`(${WORD}${WORD}${WORD})Email:`).exec(head);
  const answerDate =
    /Посостояниюна(\d{2}\.\d{2}\.\d{4})/.exec(head) || /от(\d{2}\.\d{2}\.\d{4})/.exec(head);

  return {
    fio,
    birth,
    caseNo: caseNo ? caseNo[1].replace(/[.,;]+$/, '') : null,
    manager: manager ? splitFio(manager[1]) : null,
    answerDate: answerDate ? answerDate[1] : null,
  };
}
