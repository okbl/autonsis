/*
 * Имена файлов и папок. Чистые функции — их легко проверить тестами, и они
 * же переедут в другую среду, если однажды появится отдельная программа.
 *
 * Папка — на каждый день скачивания: «НСИС\20.09.2026\».
 * Имя    — по умолчанию «дата - НСИС - номер дела.pdf»: так в папке сразу
 *          видно, откуда файл и к какому делу он относится. Остальные
 *          варианты (ФИО, дело, и то и другое) остаются в настройках.
 */

const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const MAX_BASE = 110;

export function two(n) {
  return String(n).padStart(2, '0');
}

export function folderForDay(date = new Date()) {
  return `${two(date.getDate())}.${two(date.getMonth() + 1)}.${date.getFullYear()}`;
}

export function stampFor(date = new Date()) {
  return (
    `${two(date.getDate())}.${two(date.getMonth() + 1)}.${date.getFullYear()} ` +
    `${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`
  );
}

export function sanitize(part) {
  return part
    .replace(BAD_CHARS, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, MAX_BASE);
}

/**
 * Имя файла ответа.
 * @param {{fio: string[], caseNo: string|null}} parsed
 * @param {Date} when время раскладки
 * @param {{nameBy?: 'dateCase'|'fio'|'case'|'both'}} opts чем называть файл
 */
export function fileNameFor(parsed, when = new Date(), opts = {}) {
  const mode = opts.nameBy || 'dateCase';
  const names = (parsed && parsed.fio) || [];
  const caseNo = parsed && parsed.caseNo ? sanitize(parsed.caseNo) : '';
  let who = names.length ? names[0] : '';
  if (names.length > 1) who += ' и др.';

  // Вариант по умолчанию: дата скачивания, источник и номер дела в АС.
  // Время в имя не идёт — файлы и так лежат в папке за день, а совпадения
  // разводит «Файл (1).pdf».
  if (mode === 'dateCase') {
    const tail = caseNo || who || 'Не определено';
    return `${sanitize([folderForDay(when), 'НСИС', tail].join(' - '))}.pdf`;
  }

  // Если того, чем просили называть, в ответе не нашлось — берём второе,
  // чтобы файл не превратился в безликое «Не определено».
  const parts = [];
  if (mode === 'case') parts.push(caseNo || who);
  else if (mode === 'fio') parts.push(who || caseNo);
  else parts.push(...[who, caseNo].filter(Boolean));
  if (!parts.length || !parts[0]) parts[0] = 'Не определено';

  parts.push(stampFor(when));
  return `${sanitize(parts.join(' — '))}.pdf`;
}

/**
 * Папки, в которые кладётся файл: вложенность задаётся настройками.
 * Порядок постоянный — ФУ, дело, день, — чтобы раскладка не перемешалась,
 * если переключить настройку в середине работы.
 * @returns {string[]} например ['Морза Юрий Сергеевич', 'А50-26151-2025']
 */
export function folderFor(parsed, when = new Date(), opts = {}) {
  const out = [];
  if (opts.byManager) out.push(sanitize((parsed && parsed.manager) || 'ФУ не определён'));
  if (opts.byCase) out.push(sanitize((parsed && parsed.caseNo) || 'Без номера дела'));
  if (opts.byDay !== false) out.push(folderForDay(when));
  return out;
}

const RU = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',
  ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
};

/*
 * Имя латиницей. Нужно там, где файл отдаётся обычным скачиванием: браузер
 * выбрасывает имя целиком, если в нём есть хоть один не-ASCII символ, и файл
 * превращается в безымянный «download.pdf». В выбранную папку имя пишется
 * как есть, по-русски.
 */
export function asciiName(name) {
  const out = String(name)
    .replace(/[—–]/g, '-')
    .replace(/[«»„“”"']/g, '')
    .replace(/./gu, (ch) => {
      const lower = ch.toLowerCase();
      if (!RU[lower] && RU[lower] !== '') return /[\x20-\x7E]/.test(ch) ? ch : '_';
      const t = RU[lower];
      return ch === lower ? t : t.charAt(0).toUpperCase() + t.slice(1);
    })
    .replace(/_{2,}/g, '_')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out || 'nsis.pdf';
}

/** «Файл.pdf» → «Файл (1).pdf» → «Файл (2).pdf» … */
export function withCopyIndex(name, index) {
  if (!index) return name;
  const dot = name.lastIndexOf('.');
  const base = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? '' : name.slice(dot);
  return `${base} (${index})${ext}`;
}
