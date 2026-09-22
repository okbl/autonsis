/*
 * Имена файлов и папок. Чистые функции — их легко проверить тестами, и они
 * же переедут в другую среду, если однажды появится отдельная программа.
 *
 * Папка — на каждый день скачивания: «НСИС\20.09.2026\».
 * Имя    — «ФИО — дата-время.pdf», как в задании, плюс номер дела, когда он
 *          нашёлся в ответе: искать файл по делу удобнее, чем по дате.
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
 * @param {Date} when время скачивания
 * @param {{withCase?: boolean}} opts
 */
export function fileNameFor(parsed, when = new Date(), opts = {}) {
  const withCase = opts.withCase !== false;
  const names = (parsed && parsed.fio) || [];
  let who = names.length ? names[0] : 'Не определено';
  if (names.length > 1) who += ' и др.';
  const parts = [who];
  if (withCase && parsed && parsed.caseNo) parts.push(sanitize(parsed.caseNo));
  parts.push(stampFor(when));
  return `${sanitize(parts.join(' — '))}.pdf`;
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
