(function(){'use strict';
/*
 * Текстовый слой PDF без внешних библиотек.
 *
 * pdf.js сюда не годится: код должен уезжать в закладку или сниппет
 * DevTools, а это мегабайт на страницу НСИС ради одной строки «в ответ на
 * запрос в отношении…». Ответы НСИС устроены единообразно: Flate-сжатые
 * потоки, шрифты Identity-H с картами ToUnicode. Этого достаточно, чтобы
 * прочитать нужное своими руками — здесь примерно сто строк вместо
 * мегабайта.
 *
 * Модуль ничего не знает ни про DOM, ни про файловую систему: распаковку
 * ему передают снаружи (в браузере DecompressionStream, в тестах zlib),
 * поэтому один и тот же код работает в странице и в Node.
 */

/** Байты → строка latin1: байт равен коду символа, разметка остаётся читаемой. */
function latin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return out;
}

function toBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/*
 * Объекты собираем по заголовкам «N G obj», а телом считаем всё до
 * следующего заголовка. Искать «endobj» нельзя: в сжатом потоке эти байты
 * встречаются случайно, и объект обрывается на середине — именно так
 * теряется текст страницы.
 */
function readObjects(raw) {
  const objs = new Map();
  const re = /(?:^|[^0-9])(\d+)\s+(\d+)\s+obj\b/g;
  const heads = [];
  let m;
  while ((m = re.exec(raw))) {
    heads.push({ num: Number(m[1]), start: m.index + m[0].length });
    re.lastIndex = m.index + m[0].length;
  }
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].start : raw.length;
    const body = raw.slice(heads[i].start, end);
    objs.set(heads[i].num, body);
  }
  return objs;
}

function dictOf(body) {
  return body.slice(0, body.indexOf('stream') >= 0 ? body.indexOf('stream') : body.length);
}

async function streamOf(body, inflate) {
  const m = /stream\r?\n|stream\r/.exec(body);
  if (!m) return null;
  const start = m.index + m[0].length;
  const len = /\/Length\s+(\d+)/.exec(dictOf(body));
  let data;
  if (len && start + Number(len[1]) <= body.length) {
    data = body.slice(start, start + Number(len[1]));
  } else {
    const e = body.indexOf('endstream', start);
    data = body.slice(start, e < 0 ? body.length : e);
  }
  if (!/\/FlateDecode/.test(dictOf(body))) return data;
  try {
    return latin1(await inflate(toBytes(data)));
  } catch {
    return null;
  }
}

/** Карта ToUnicode: код глифа → символ. */
function parseCMap(src) {
  const map = new Map();
  const hex = (s) => s.replace(/\s+/g, '');
  const chars = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = chars.exec(src))) {
    const pair = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g;
    let p;
    while ((p = pair.exec(m[1]))) {
      map.set(parseInt(hex(p[1]), 16), fromUtf16be(hex(p[2])));
    }
  }
  const ranges = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = ranges.exec(src))) {
    const triple = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g;
    let t;
    while ((t = triple.exec(m[1]))) {
      const lo = parseInt(hex(t[1]), 16);
      const hi = Math.min(parseInt(hex(t[2]), 16), lo + 5000);
      const dst = parseInt(hex(t[3]), 16);
      for (let i = lo; i <= hi; i++) map.set(i, String.fromCharCode(dst + (i - lo)));
    }
  }
  return map;
}

function fromUtf16be(hexStr) {
  let out = '';
  for (let i = 0; i + 3 < hexStr.length + 1; i += 4) {
    const code = parseInt(hexStr.slice(i, i + 4), 16);
    if (!Number.isNaN(code)) out += String.fromCharCode(code);
  }
  return out;
}

/*
 * Слова в ответах НСИС склеены: пробел набран смещением, а не символом.
 * Поэтому в массиве TJ отрицательное смещение крупнее порога считаем
 * пробелом — так «ЩенниковАлексей» снова становится «Щенников Алексей».
 */
const SPACE_KERN = 120;

function decodeContent(content, fonts) {
  const out = [];
  let font = null;
  const re = /\/([A-Za-z0-9#]+)\s+[-\d.]+\s+Tf|\[((?:[^\][\\]|\\.)*)\]\s*TJ|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:[^()\\]|\\.)*)\)\s*Tj|(T\*|TD|Td|ET)/g;
  let m;
  while ((m = re.exec(content))) {
    if (m[1] !== undefined) {
      font = fonts.get(m[1]) || null;
    } else if (m[2] !== undefined) {
      out.push(decodeArray(m[2], font));
    } else if (m[3] !== undefined) {
      out.push(decodeHex(m[3], font));
    } else if (m[4] !== undefined) {
      out.push(decodeLiteral(m[4], font));
    } else {
      out.push('\n');
    }
  }
  return out.join('').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
}

function decodeArray(body, font) {
  let out = '';
  const re = /<([0-9A-Fa-f\s]*)>|\(((?:[^()\\]|\\.)*)\)|(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) out += decodeHex(m[1], font);
    else if (m[2] !== undefined) out += decodeLiteral(m[2], font);
    else if (Number(m[3]) <= -SPACE_KERN && !out.endsWith(' ')) out += ' ';
  }
  return out;
}

function decodeHex(hexStr, font) {
  const hex = hexStr.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const code = parseInt(hex.slice(i, i + 4), 16);
    if (Number.isNaN(code)) continue;
    out += font && font.has(code) ? font.get(code) : '';
  }
  return out;
}

function decodeLiteral(str, font) {
  const text = str.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '', f: '' }[c] ?? c));
  if (!font) return text;
  let out = '';
  for (const ch of text) out += font.has(ch.charCodeAt(0)) ? font.get(ch.charCodeAt(0)) : ch;
  return out;
}

function refsIn(str) {
  const out = [];
  const re = /(\d+)\s+0\s+R/g;
  let m;
  while ((m = re.exec(str))) out.push(Number(m[1]));
  return out;
}

/** Страницы в порядке дерева /Pages, а не в порядке байтов файла. */
function orderPages(objs) {
  const isPage = (b) => /\/Type\s*\/Page[^s]/.test(dictOf(b));
  const roots = [];
  for (const [num, body] of objs) {
    const d = dictOf(body);
    if (/\/Type\s*\/Pages\b/.test(d) && !/\/Parent\b/.test(d)) roots.push(num);
  }
  const ordered = [];
  const seen = new Set();
  const walk = (num, depth) => {
    if (depth > 32 || seen.has(num)) return;
    seen.add(num);
    const body = objs.get(num);
    if (!body) return;
    const d = dictOf(body);
    if (isPage(body)) {
      ordered.push(num);
      return;
    }
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(d);
    if (kids) for (const k of refsIn(kids[1])) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  if (!ordered.length) {
    for (const [num, body] of objs) if (isPage(body)) ordered.push(num);
  }
  return ordered;
}

/**
 * Текст первых maxPages страниц PDF.
 * @param {Uint8Array} bytes
 * @param {(u8: Uint8Array) => Promise<Uint8Array>} inflate
 * @returns {Promise<string[]>}
 */
async function pdfPagesText(bytes, inflate, maxPages = 3) {
  const raw = latin1(bytes);
  const objs = readObjects(raw);
  const cmaps = new Map();

  const cmapFor = async (fontNum) => {
    const body = objs.get(fontNum);
    if (!body) return null;
    const m = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(dictOf(body));
    if (!m) return null;
    const num = Number(m[1]);
    if (!cmaps.has(num)) {
      const src = await streamOf(objs.get(num) || '', inflate);
      cmaps.set(num, src ? parseCMap(src) : new Map());
    }
    return cmaps.get(num);
  };

  const pages = orderPages(objs).slice(0, maxPages);
  const texts = [];
  for (const num of pages) {
    const body = objs.get(num) || '';
    const d = dictOf(body);
    let resSrc = d;
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(d);
    if (resRef) resSrc = dictOf(objs.get(Number(resRef[1])) || '');
    const fonts = new Map();
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resSrc);
    if (fontDict) {
      const re = /\/([A-Za-z0-9#]+)\s+(\d+)\s+0\s+R/g;
      let f;
      while ((f = re.exec(fontDict[1]))) {
        fonts.set(f[1], await cmapFor(Number(f[2])));
      }
    }
    const contents = /\/Contents\s*\[([\s\S]*?)\]/.exec(d);
    const ids = contents ? refsIn(contents[1]) : refsIn((/\/Contents\s+(\d+\s+0\s+R)/.exec(d) || [])[1] || '');
    let content = '';
    for (const id of ids) content += (await streamOf(objs.get(id) || '', inflate)) || '';
    texts.push(decodeContent(content, fonts));
  }
  return texts;
}

/** Распаковка через DecompressionStream — для браузера. */
async function browserInflate(u8) {
  const tryOne = async (format) => {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  try {
    return await tryOne('deflate');
  } catch {
    return await tryOne('deflate-raw');
  }
}

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
function parseAnswer(pages) {
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

function two(n) {
  return String(n).padStart(2, '0');
}

function folderForDay(date = new Date()) {
  return `${two(date.getDate())}.${two(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function stampFor(date = new Date()) {
  return (
    `${two(date.getDate())}.${two(date.getMonth() + 1)}.${date.getFullYear()} ` +
    `${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}`
  );
}

function sanitize(part) {
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
function fileNameFor(parsed, when = new Date(), opts = {}) {
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
function asciiName(name) {
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
function withCopyIndex(name, index) {
  if (!index) return name;
  const dot = name.lastIndexOf('.');
  const base = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? '' : name.slice(dot);
  return `${base} (${index})${ext}`;
}

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
function apiError(code, extra = {}) {
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

const Nsis = {
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
function isReadyFile(file) {
  return !!file && !!file.fileId && !!file.signId && Number(file.fileSize) > 0;
}

/** Готовый к скачиванию ответ из записи журнала обращений. */
function answerOf(query) {
  const answers = (query && query.answers) || [];
  for (const answer of answers) {
    if (isReadyFile(answer && answer.pdf)) return answer.pdf;
  }
  return null;
}

function statusCodeOf(query) {
  return (query && query.status && query.status.code) || '';
}

/** ФИО текущего ФУ из профиля — имена полей у кабинета могут отличаться. */
function managerName(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const data = profile.data && typeof profile.data === 'object' ? profile.data : profile;
  const parts = [data.lastName, data.firstName, data.middleName].filter(Boolean);
  if (parts.length) return parts.join(' ');
  for (const key of ['fullName', 'fio', 'name', 'displayName', 'login', 'email']) {
    if (typeof data[key] === 'string' && data[key].trim()) return data[key].trim();
  }
  return null;
}

/*
 * Хранилище: журнал и файлы.
 *
 * Журнал живёт в IndexedDB домена НСИС, а его копия — файлом «журнал.json»
 * в той же папке, где лежат ответы. Причина простая: браузерное хранилище
 * стирается вместе с данными браузера, а папка с делами — нет.
 *
 * Файлы пишутся через File System Access API в папку, которую ФУ выбирает
 * один раз. Если доступ к папкам закрыт политикой, остаётся запасной путь:
 * обычная загрузка с правильным именем — тогда файл попадает в «Загрузки»
 * без раскладки по дням, и в журнале это видно.
 */

const DB_NAME = 'nsis-auto';
const JOURNAL = 'журнал.json';
const DB_VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('answers')) {
        const s = db.createObjectStore('answers', { keyPath: 'requestId' });
        s.createIndex('hash', 'hash');
        s.createIndex('savedAt', 'savedAt');
      }
      if (!db.objectStoreNames.contains('attempts')) {
        db.createObjectStore('attempts', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const Store = {
  db: null,

  async init() {
    this.db = await open();
    return this;
  },

  meta(key, value) {
    if (value === undefined) {
      return tx(this.db, 'meta', 'readonly', (s) => s.get(key)).then((r) => (r ? r.value : null));
    }
    return tx(this.db, 'meta', 'readwrite', (s) => s.put({ key, value }));
  },

  all() {
    return tx(this.db, 'answers', 'readonly', (s) => s.getAll()).then((r) => r || []);
  },

  get(requestId) {
    return tx(this.db, 'answers', 'readonly', (s) => s.get(requestId));
  },

  put(entry) {
    return tx(this.db, 'answers', 'readwrite', (s) => s.put(entry));
  },

  byHash(hash) {
    return tx(this.db, 'answers', 'readonly', (s) => s.index('hash').get(hash));
  },

  addAttempt(requestId, error) {
    return tx(this.db, 'attempts', 'readwrite', (s) =>
      s.add({ requestId, at: new Date().toISOString(), error })
    );
  },

  attempts(requestId) {
    return tx(this.db, 'attempts', 'readonly', (s) => s.getAll()).then((rows) =>
      (rows || []).filter((r) => r.requestId === requestId)
    );
  },
};

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/*
 * Две папки: куда складываем (папка НСИС) и откуда берём (папка загрузок).
 * Устроены одинаково, поэтому общая заготовка.
 */
function directory(pickerId) {
  return {
    handle: null,

    supported() {
      return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
    },

    /** Восстановить папку из прошлого сеанса. Без клика разрешение не вернуть. */
    async restore(saved) {
      if (!saved || typeof saved.queryPermission !== 'function') return null;
      this.handle = saved;
      try {
        const state = await saved.queryPermission({ mode: 'readwrite' });
        return state === 'granted' ? saved : null;
      } catch {
        return null;
      }
    },

    async pick() {
      this.handle = await window.showDirectoryPicker({ mode: 'readwrite', id: pickerId });
      return this.handle;
    },

    async grant() {
      if (!this.handle) return false;
      if ((await this.handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
      return (await this.handle.requestPermission({ mode: 'readwrite' })) === 'granted';
    },
  };
}

const Folder = {
  ...directory('nsis-root'),

  async dayDir(day) {
    if (!this.handle) throw new Error('папка не выбрана');
    return this.handle.getDirectoryHandle(day, { create: true });
  },

  async exists(dir, name) {
    try {
      await dir.getFileHandle(name, { create: false });
      return true;
    } catch {
      return false;
    }
  },

  /** Запись с защитой от совпадения имён: «Файл (1).pdf», «Файл (2).pdf» … */
  async write(day, name, blob, nameAt) {
    const dir = await this.dayDir(day);
    let final = name;
    for (let i = 1; i < 100 && (await this.exists(dir, final)); i++) final = nameAt(name, i);
    const file = await dir.getFileHandle(final, { create: true });
    const stream = await file.createWritable();
    await stream.write(blob);
    await stream.close();
    return { name: final, dir: day };
  },

  async read(day, name) {
    const dir = await this.handle.getDirectoryHandle(day, { create: false });
    const file = await dir.getFileHandle(name, { create: false });
    return file.getFile();
  },

  /** Копия журнала рядом с файлами — на случай очистки браузера. */
  async writeJournal(rows) {
    if (!this.handle) return;
    const file = await this.handle.getFileHandle(JOURNAL, { create: true });
    const stream = await file.createWritable();
    await stream.write(new Blob([JSON.stringify(rows, null, 1)], { type: 'application/json' }));
    await stream.close();
  },

  /** Журнал из папки: он же связывает страницу-приложение и панель на НСИС. */
  async readJournal() {
    if (!this.handle) return [];
    try {
      const file = await this.handle.getFileHandle(JOURNAL, { create: false });
      const text = await (await file.getFile()).text();
      const rows = JSON.parse(text);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  },
};

const Inbox = {
  ...directory('nsis-inbox'),

  /** PDF из папки загрузок — только верхний уровень, без обхода вложенных. */
  async listPdfs() {
    if (!this.handle) return [];
    const files = [];
    for await (const [name, entry] of this.handle.entries()) {
      if (entry.kind !== 'file' || !/\.pdf$/i.test(name)) continue;
      // Недокачанные файлы браузера (.crdownload) сюда не попадают по маске.
      files.push(await entry.getFile());
    }
    return files;
  },

  async remove(name) {
    if (!this.handle) return;
    await this.handle.removeEntry(name);
  },
};

/** Запасной путь: обычная загрузка браузера с нужным именем. */
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 10000);
}

/*
 * Ядро: два источника ответов, общая обработка, очередь, повторы, журнал.
 *
 * Источников два, и различаются они только тем, откуда взялись байты PDF:
 *   — папка (обычно «Загрузки»): страница сама её просматривает, а файлы
 *     можно и просто перетащить на неё;
 *   — НСИС: журнал обращений и скачивание запросом — доступно только когда
 *     код выполняется на странице кабинета, потому что сессия принадлежит
 *     ему, а не нам.
 *
 * Дальше путь общий: hash → дубликаты → разбор письма → имя → папка за день
 * → запись в журнал. Правила, которые здесь важнее всего:
 *   — ошибка одного ответа не трогает остальные: она остаётся в его записи;
 *   — обращение, которое уже обработано, второй раз не скачивается (ключ
 *     requestId известен до скачивания, в отличие от hash содержимого);
 *   — hash — второй уровень: ловит тот же ответ, пришедший другим путём;
 *   — после простоя приложение проходит всё заново и берёт то, чего у него
 *     нет, поэтому неважно, сколько его не открывали.
 */

const HUMAN = {
  network: 'НСИС недоступна',
  blocked: 'НСИС доступен только со страницы кабинета',
  session: 'Сессия истекла',
  http: 'Ошибка скачивания',
  pdf: 'Ошибка скачивания',
  read: 'Не удалось прочитать файл',
  write: 'Не удалось сохранить файл',
  no_fio: 'Не удалось определить ФИО',
};

const STATUS = {
  saved: 'Разложено',
  no_fio: 'ФИО не определено',
  duplicate: 'Пропущено (дубликат)',
  error: 'Ошибка',
};

const DEFAULTS = {
  intervalMin: 15, // проверка НСИС, минуты
  watchSec: 10, // просмотр папки загрузок, секунды
  concurrency: 4,
  retries: 3,
  withCase: true,
  deepPages: 4, // страниц журнала обращений за проверку (по 50)
  moveFromInbox: true, // убирать разложенное из папки загрузок
};

/*
 * Файл, скачанный закладкой, называется «nsis-<обращение>.pdf» — так страница
 * узнаёт, к какому обращению он относится, и дубликаты ловятся точно, а не
 * только по содержимому.
 */
function idFromName(name) {
  const m = /^(?:nsis|нсис)-(.+)\.pdf$/i.exec(String(name || ''));
  return m ? m[1] : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const Core = {
  settings: { ...DEFAULTS },
  state: {
    mode: 'page', // page (страница-приложение) | panel (панель на сайте НСИС)
    manager: null,
    nsis: 'unknown', // unknown | ok | session | down | blocked
    auto: true,
    busy: false,
    lastCheck: null,
    lastError: null,
    folder: 'none', // none | ready | denied | unsupported
    inbox: 'none',
    news: 0,
    entries: [],
  },
  listeners: new Set(),
  seen: new Set(), // файлы папки, уже опознанные в этом сеансе

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  emit() {
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch (e) {
        console.error('[НСИС] ошибка обновления интерфейса', e);
      }
    }
  },

  async start(mode) {
    this.state.mode = mode || 'page';
    await Store.init();
    const saved = await Store.meta('settings');
    if (saved) this.settings = { ...DEFAULTS, ...saved };
    const autoSaved = await Store.meta('auto');
    this.state.auto = autoSaved === null ? true : !!autoSaved;

    if (!Folder.supported()) {
      this.state.folder = 'unsupported';
      this.state.inbox = 'unsupported';
    } else {
      this.state.folder = await this.restore(Folder, 'folder');
      this.state.inbox = await this.restore(Inbox, 'inbox');
    }

    await this.reload();
    await this.mergeFolderJournal();
    this.emit();
    if (this.state.auto) this.startAuto();
    this.tick();
    return this;
  },

  async restore(target, key) {
    const handle = await Store.meta(key);
    if (!handle) return 'none';
    return (await target.restore(handle)) ? 'ready' : 'denied';
  },

  async saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    await Store.meta('settings', this.settings);
    if (this.state.auto) this.startAuto();
    this.emit();
  },

  startAuto() {
    this.stopAuto(true);
    this.state.auto = true;
    Store.meta('auto', true);
    const ms =
      this.state.mode === 'panel'
        ? Math.max(1, this.settings.intervalMin) * 60000
        : Math.max(3, this.settings.watchSec) * 1000;
    this.timer = setInterval(() => this.tick(), ms);
    this.emit();
  },

  stopAuto(quiet) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!quiet) {
      this.state.auto = false;
      Store.meta('auto', false);
      this.emit();
    }
  },

  /** Один цикл: папка и, если она нам доступна, НСИС. */
  async tick() {
    if (this.state.busy) return;
    if (this.state.inbox === 'ready') await this.scanInbox();
    if (this.state.mode === 'panel' || this.state.nsis === 'ok') await this.checkNsis();
  },

  async pick(which) {
    const target = which === 'inbox' ? Inbox : Folder;
    const handle = await target.pick(which === 'inbox' ? 'Папка загрузок' : 'Папка НСИС');
    await Store.meta(which, handle);
    this.state[which] = 'ready';
    if (which === 'folder') await this.mergeFolderJournal();
    this.emit();
    this.tick();
  },

  async grant(which) {
    const target = which === 'inbox' ? Inbox : Folder;
    const ok = await target.grant();
    this.state[which] = ok ? 'ready' : 'denied';
    if (ok && which === 'folder') await this.mergeFolderJournal();
    this.emit();
    if (ok) this.tick();
    return ok;
  },

  async reload() {
    const rows = await Store.all();
    rows.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    this.state.entries = rows;
  },

  counters() {
    const today = folderForDay(new Date());
    let saved = 0;
    let errors = 0;
    let skipped = 0;
    for (const e of this.state.entries) {
      if (e.status === 'error') errors++;
      else if (e.status === 'duplicate') skipped++;
      else if (e.day === today) saved++;
    }
    return { saved, errors, skipped, news: this.state.news };
  },

  /* ---------------- источник: папка ---------------- */

  async scanInbox() {
    if (this.state.inbox !== 'ready' || this.state.busy) return;
    this.state.busy = true;
    this.emit();
    try {
      const files = await Inbox.listPdfs();
      const fresh = files.filter((f) => !this.seen.has(`${f.name}:${f.size}:${f.lastModified}`));
      this.state.news = fresh.length;
      this.emit();
      for (const file of fresh) {
        this.seen.add(`${file.name}:${file.size}:${file.lastModified}`);
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const result = await this.intake(bytes, { source: file.name, requestId: idFromName(file.name) });
          if (this.settings.moveFromInbox && result !== 'error') await Inbox.remove(file.name);
        } catch (e) {
          console.warn('[НСИС] файл не обработан', file.name, e);
        }
        await this.reload();
        this.emit();
      }
      this.state.lastCheck = new Date().toISOString();
    } finally {
      this.state.busy = false;
      this.state.news = 0;
      this.emit();
      await this.reload();
      this.emit();
      this.mirrorJournal();
    }
  },

  /** Перетащенные на страницу файлы — тот же путь, минуя папку. */
  async addFiles(list) {
    const files = [...list].filter((f) => /\.pdf$/i.test(f.name));
    if (!files.length) return;
    this.state.busy = true;
    this.state.news = files.length;
    this.emit();
    try {
      for (const file of files) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          await this.intake(bytes, { source: file.name, requestId: idFromName(file.name) });
        } catch (e) {
          console.warn('[НСИС] файл не обработан', file.name, e);
        }
        await this.reload();
        this.emit();
      }
    } finally {
      this.state.busy = false;
      this.state.news = 0;
      await this.reload();
      this.emit();
      this.mirrorJournal();
    }
  },

  /* ---------------- источник: НСИС ---------------- */

  /** Доступен ли кабинет с этого адреса. Со страницы вне НСИС — нет. */
  async probeNsis() {
    try {
      const profile = await Nsis.profile();
      this.state.manager = managerName(profile) || this.state.manager;
      this.state.nsis = 'ok';
    } catch (e) {
      this.state.nsis = e.code === 'session' ? 'session' : this.state.mode === 'panel' ? 'down' : 'blocked';
    }
    this.emit();
    return this.state.nsis;
  },

  async checkNsis() {
    if (this.state.busy) return;
    this.state.busy = true;
    this.state.lastError = null;
    this.emit();
    try {
      const profile = await Nsis.profile();
      this.state.manager = managerName(profile) || this.state.manager;
      this.state.nsis = 'ok';
      this.emit();

      const queries = await this.fetchQueries();
      const todo = [];
      for (const q of queries) {
        // Готовность определяем по самому файлу, а не по коду статуса:
        // кабинет проверяет ровно это, а список кодов может пополниться.
        const pdf = answerOf(q);
        if (!pdf) continue;
        const known = await Store.get(q.requestId);
        if (!known) todo.push({ query: q, pdf });
        else if (known.status === 'error' && (known.attempts || 0) < this.settings.retries) {
          todo.push({ query: q, pdf });
        }
      }
      this.state.news = todo.length;
      this.emit();

      await this.runQueue(todo);
      this.state.lastCheck = new Date().toISOString();
    } catch (e) {
      this.state.nsis =
        e.code === 'session' ? 'session' : this.state.mode === 'panel' ? 'down' : 'blocked';
      this.state.lastError = HUMAN[this.state.nsis === 'blocked' ? 'blocked' : e.code] || 'Неизвестная ошибка';
    } finally {
      this.state.busy = false;
      this.emit();
      await this.reload();
      this.state.news = 0;
      this.emit();
      this.mirrorJournal();
    }
  },

  async fetchQueries() {
    const limit = 50;
    const all = [];
    for (let page = 0; page < this.settings.deepPages; page++) {
      const data = await Nsis.log({ limit, offset: page * limit });
      // Кабинет отдаёт { queries: [...] }; на случай обёртки data — обе формы.
      const rows = (data && (data.queries || (data.data && data.data.queries))) || [];
      all.push(...rows);
      if (rows.length < limit) break;
    }
    return all;
  },

  async runQueue(items) {
    const queue = items.slice();
    const workers = Array.from(
      { length: Math.max(1, Math.min(8, this.settings.concurrency)) },
      async () => {
        while (queue.length) {
          if (this.state.nsis === 'session') return;
          await this.download(queue.shift());
          await this.reload();
          this.emit();
        }
      }
    );
    await Promise.all(workers);
  },

  /** Скачивание одного ответа НСИС с повторами. */
  async download({ query, pdf }, force = false) {
    const requestId = query.requestId;
    const prev = (await Store.get(requestId)) || {};
    let attempts = prev.attempts || 0;
    const maxTries = Math.max(1, this.settings.retries);

    for (let tryNo = 0; tryNo < maxTries; tryNo++) {
      attempts++;
      try {
        const blob = await Nsis.answerPdf(pdf);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await this.intake(bytes, {
          requestId,
          pdfRef: pdf,
          createDate: query.createDate,
          attempts,
          force,
        });
        return;
      } catch (e) {
        const code = e.code || 'write';
        const human = HUMAN[code] || 'Ошибка скачивания';
        if (code === 'write' && this.state.folder === 'ready') this.state.folder = 'denied';
        await Store.addAttempt(requestId, human);
        const keep = prev.status === 'saved' || prev.status === 'no_fio';
        if (code === 'session') {
          this.state.nsis = 'session';
          await this.fail(requestId, prev, { keep, human, code, attempts, pdf, query });
          return;
        }
        if (tryNo === maxTries - 1) {
          await this.fail(requestId, prev, { keep, human, code, attempts, pdf, query });
          return;
        }
        await sleep(Math.min(15000, 1000 * 2 ** tryNo));
      }
    }
  },

  async fail(requestId, prev, { keep, human, code, attempts, pdf, query }) {
    // Файл, сохранённый раньше, остаётся сохранённым: неудачная повторная
    // загрузка не должна стирать его из журнала.
    await Store.put({
      ...prev,
      requestId,
      status: keep ? prev.status : 'error',
      error: human,
      errorCode: code,
      attempts,
      pdfRef: pdf,
      createDate: (query && query.createDate) || prev.createDate || null,
      manager: prev.manager || this.state.manager,
      savedAt: prev.savedAt || new Date().toISOString(),
    });
  },

  /* ---------------- общая обработка ---------------- */

  /**
   * Байты PDF → журнал и файл на диске. Общая часть для обоих источников.
   * @returns {'saved'|'no_fio'|'duplicate'|'error'}
   */
  async intake(bytes, meta = {}) {
    const hash = await sha256(bytes);
    const requestId = meta.requestId || `hash:${hash}`;
    const prev = (await Store.get(requestId)) || {};

    if (!meta.force) {
      const twin = await Store.byHash(hash);
      if (twin && twin.requestId !== requestId) {
        await Store.put({
          requestId,
          hash,
          status: 'duplicate',
          duplicateOf: twin.requestId,
          fio: twin.fio || [],
          caseNo: twin.caseNo || null,
          birth: twin.birth || {},
          manager: twin.manager || this.state.manager,
          answerDate: twin.answerDate || null,
          createDate: meta.createDate || null,
          source: meta.source || null,
          pdfRef: meta.pdfRef || null,
          attempts: meta.attempts || 1,
          savedAt: new Date().toISOString(),
        });
        return 'duplicate';
      }
      if (prev.status === 'saved' || prev.status === 'no_fio') return 'duplicate';
    }

    let parsed = { fio: [], birth: {}, caseNo: null, manager: null, answerDate: null };
    let parseFailed = false;
    try {
      parsed = parseAnswer(await pdfPagesText(bytes, browserInflate, 4));
    } catch (e) {
      parseFailed = true;
      console.warn('[НСИС] не удалось разобрать PDF', e);
    }

    const when = new Date();
    const day = folderForDay(when);
    const name = fileNameFor(parsed, when, { withCase: this.settings.withCase });
    const blob = new Blob([bytes], { type: 'application/pdf' });
    let placed;
    if (this.state.folder === 'ready') {
      try {
        placed = { ...(await Folder.write(day, name, blob, withCopyIndex)), place: 'folder' };
      } catch (e) {
        // Если файловая система не приняла имя с кириллицей — пишем латиницей,
        // но файл не теряем.
        if (e && (e.name === 'TypeError' || e.name === 'TypeMismatchError' || e.name === 'InvalidModificationError')) {
          placed = { ...(await Folder.write(day, asciiName(name), blob, withCopyIndex)), place: 'folder' };
        } else throw e;
      }
    } else {
      // Браузер отбрасывает имя с кириллицей при обычном скачивании — там
      // только латиница, иначе файл станет безымянным «download.pdf».
      const flat = withCopyIndex(asciiName(name), prev.copies || 0);
      downloadBlob(blob, flat);
      placed = { name: flat, place: 'downloads' };
    }

    const status = parsed.fio.length ? 'saved' : 'no_fio';
    await Store.put({
      requestId,
      status,
      fio: parsed.fio,
      birth: parsed.birth,
      caseNo: parsed.caseNo,
      answerDate: parsed.answerDate,
      createDate: meta.createDate || prev.createDate || null,
      manager: parsed.manager || this.state.manager,
      fileName: placed.name,
      // День всегда датой: по нему считается «сегодня» и работает фильтр,
      // даже когда файл ушёл в «Загрузки» без раскладки по папкам.
      day,
      place: placed.place,
      path: `${placed.place === 'folder' ? day : 'Загрузки'}\\${placed.name}`,
      hash,
      size: bytes.length,
      source: meta.source || (meta.requestId ? 'НСИС' : null),
      attempts: meta.attempts || 1,
      error: parsed.fio.length ? null : parseFailed ? HUMAN.pdf : HUMAN.no_fio,
      copies: (prev.copies || 0) + (meta.force ? 1 : 0),
      pdfRef: meta.pdfRef || prev.pdfRef || null,
      savedAt: new Date().toISOString(),
    });
    return status;
  },

  /** «Ещё раз» — всегда создаёт новый файл рядом. */
  async again(requestId) {
    const entry = await Store.get(requestId);
    if (!entry) return;
    if (this.state.folder === 'denied') await this.grant('folder');
    this.state.busy = true;
    this.emit();
    try {
      if (entry.pdfRef && this.state.nsis === 'ok') {
        await this.download(
          { query: { requestId, createDate: entry.createDate }, pdf: entry.pdfRef },
          true
        );
      } else if (entry.place === 'folder' && entry.fileName && this.state.folder === 'ready') {
        // Из НСИС не дотянуться — делаем копию уже сохранённого файла.
        const file = await Folder.read(entry.day, entry.fileName);
        await this.intake(new Uint8Array(await file.arrayBuffer()), {
          requestId,
          createDate: entry.createDate,
          source: entry.source,
          force: true,
        });
      }
    } catch (e) {
      console.warn('[НСИС] повторная загрузка не удалась', e);
    } finally {
      this.state.busy = false;
      await this.reload();
      this.emit();
      this.mirrorJournal();
    }
  },

  async openFile(entry) {
    if (!entry || !entry.fileName || entry.place !== 'folder' || this.state.folder !== 'ready') return null;
    const file = await Folder.read(entry.day, entry.fileName);
    const url = URL.createObjectURL(file);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return url;
  },

  /* ---------------- журнал на диске ---------------- */

  toRow(e) {
    return {
      ФИО: (e.fio || []).join(', ') || 'Не определено',
      датаРождения: e.birth || {},
      дело: e.caseNo || '',
      датаОтвета: e.answerDate || '',
      файл: e.fileName || '',
      путь: e.path || '',
      ФУ: e.manager || '',
      hash: e.hash || '',
      статус: STATUS[e.status] || e.status,
      ошибка: e.error || '',
      попыток: e.attempts || 0,
      обращение: e.requestId,
      источник: e.source || '',
      день: e.day || '',
      место: e.place || '',
      сохранено: e.savedAt || '',
    };
  },

  fromRow(r) {
    const fio = String(r.ФИО || '').trim();
    const byStatus = Object.entries(STATUS).find(([, v]) => v === r.статус);
    return {
      requestId: r.обращение,
      status: byStatus ? byStatus[0] : 'saved',
      fio: fio && fio !== 'Не определено' ? fio.split(',').map((s) => s.trim()) : [],
      birth: r.датаРождения || {},
      caseNo: r.дело || null,
      answerDate: r.датаОтвета || null,
      fileName: r.файл || '',
      path: r.путь || '',
      manager: r.ФУ || null,
      hash: r.hash || '',
      error: r.ошибка || null,
      attempts: r.попыток || 0,
      source: r.источник || null,
      day: r.день || '',
      place: r.место || 'folder',
      savedAt: r.сохранено || new Date().toISOString(),
    };
  },

  /*
   * Журнал в браузере — кэш, источник истины — файл в папке с делами.
   * Благодаря этому страница-приложение и панель на сайте НСИС видят одно и
   * то же: они пишут в одну папку, хотя браузерные хранилища у них разные.
   */
  async mergeFolderJournal() {
    if (this.state.folder !== 'ready') return;
    try {
      const rows = await Folder.readJournal();
      let added = 0;
      for (const row of rows) {
        if (!row || !row.обращение) continue;
        if (await Store.get(row.обращение)) continue;
        await Store.put(this.fromRow(row));
        added++;
      }
      if (added) {
        await this.reload();
        this.emit();
      }
    } catch (e) {
      console.warn('[НСИС] журнал из папки прочитать не удалось', e);
    }
  },

  async mirrorJournal() {
    if (this.state.folder !== 'ready') return;
    try {
      await Folder.writeJournal(this.state.entries.map((e) => this.toRow(e)));
    } catch (e) {
      console.warn('[НСИС] копию журнала записать не удалось', e);
    }
  },
};

/*
 * Диагностика: одна кнопка — и приложение рассказывает, что у него не вышло.
 *
 * «Не работает» без подробностей стоит нескольких писем туда-обратно, а по
 * рабочему компьютеру отладчиком не походишь. Поэтому отчёт собирается прямо
 * на месте: состояние, ответы кабинета и — главное — форма данных, которые он
 * вернул. Именно по ней видно, совпадают ли наши ожидания с действительностью.
 *
 * Персональные данные в отчёт не попадают: строки с русскими буквами, почтой и
 * длинными числами заменяются на пометку о длине, остаются только служебные
 * значения вроде "done" и размеров файлов.
 */

const SAFE = /^[A-Za-z0-9_.:+-]{1,48}$/;

/** Скелет значения: ключи и типы — без личных данных. */
function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[${shape(value[0], depth + 1)}${value.length > 1 ? `, …ещё ${value.length - 1}` : ''}]`;
  }
  switch (typeof value) {
    case 'object': {
      if (depth > 3) return '{…}';
      const parts = Object.keys(value)
        .slice(0, 24)
        .map((k) => `${k}: ${shape(value[k], depth + 1)}`);
      return `{ ${parts.join(', ')} }`;
    }
    case 'string':
      if (!value) return '""';
      return SAFE.test(value) ? JSON.stringify(value) : `"<строка, ${value.length} симв.>"`;
    case 'number':
    case 'boolean':
      return String(value);
    default:
      return typeof value;
  }
}

async function probe(title, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    return { title, ok: true, ms: Date.now() - started, value };
  } catch (e) {
    return {
      title,
      ok: false,
      ms: Date.now() - started,
      code: e && e.code,
      status: e && e.status,
      text: String((e && e.message) || e),
    };
  }
}

async function report() {
  const s = Core.state;
  const lines = [];
  const add = (...parts) => lines.push(parts.join(''));

  add('НСИС — диагностика ', new Date().toLocaleString('ru-RU'));
  add('адрес: ', location.origin + location.pathname);
  add('режим: ', s.mode === 'panel' ? 'панель на странице кабинета' : 'страница-приложение');
  add('браузер: ', (navigator.userAgent.match(/(Chrome|Chromium|Firefox|Safari)\/[\d.]+/g) || []).join(' '));
  add('доступ к папкам (File System Access): ', typeof window.showDirectoryPicker === 'function' ? 'есть' : 'нет');
  add('папка НСИС: ', s.folder, ', папка загрузок: ', s.inbox);
  add('слежение: ', s.auto ? 'включено' : 'выключено', ', занят: ', String(s.busy));
  add('состояние НСИС: ', s.nsis, s.lastError ? ` (${s.lastError})` : '');
  add('ФУ: ', s.manager ? 'определён' : 'не определён');

  const entries = await Store.all().catch(() => []);
  const byStatus = {};
  for (const e of entries) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
  add('записей в журнале: ', String(entries.length), ' ', JSON.stringify(byStatus));

  const lastErrors = entries.filter((e) => e.status === 'error').slice(0, 3);
  if (lastErrors.length) {
    add('');
    add('--- последние ошибки ---');
    for (const e of lastErrors) {
      add('обращение ', String(e.requestId).slice(0, 12), '…: ', e.error || '', ' (код ', e.errorCode || '—', ', попыток ', String(e.attempts || 0), ')');
    }
  }

  add('');
  add('--- профиль кабинета ---');
  const profile = await probe('profile', () => Nsis.profile());
  if (profile.ok) {
    add('GET bff/profile → ответ получен за ', String(profile.ms), ' мс');
    add('форма: ', shape(profile.value));
  } else {
    add('GET bff/profile → ошибка: ', profile.code || '—', ' ', profile.status || '', ' ', HUMAN[profile.code] || profile.text);
  }

  add('');
  add('--- журнал обращений ---');
  const log = await probe('log', () => Nsis.log({ limit: 3, offset: 0 }));
  if (log.ok) {
    const rows = (log.value && (log.value.queries || (log.value.data && log.value.data.queries))) || [];
    add('GET bff/bff-query-log/request-log?limit=3 → ответ получен за ', String(log.ms), ' мс');
    add('верхний уровень: ', shape(log.value, 2));
    add('записей: ', String(rows.length), ', из них с готовым PDF (как их видит приложение): ',
      String(rows.filter((q) => answerOf(q)).length));
    if (rows.length) {
      add('статусы: ', rows.map((q) => statusCodeOf(q) || '—').join(', '));
      add('форма первой записи:');
      add(shape(rows[0]));
    }
  } else {
    add('GET bff/bff-query-log/request-log → ошибка: ', log.code || '—', ' ', log.status || '', ' ', HUMAN[log.code] || log.text);
  }

  return lines.join('\n');
}

/*
 * Интерфейс. Один и тот же код работает в двух видах:
 *   — страница-приложение (режим page): открыли адрес — это рабочее место;
 *   — панель поверх кабинета НСИС (режим panel), когда код запущен закладкой.
 *
 * Внутри — shadow-root: стили НСИС не влияют на нас, наши — на НСИС.
 * Оформление как в ОКБ-анализаторе: алебастровый фон, тёплый грейж
 * поверхностей, угольный текст, терракота как единственный акцент, плитки,
 * табличные цифры. Цвет несёт смысл: терракота — требует внимания,
 * кирпичный — ошибка, олива — «в порядке».
 */

const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.wrap{
  --bg:#F1ECE6;--surface:#FBF9F6;--surface-2:#E7E0D8;--line:#DDD5CD;--line-2:#C6BCB1;
  --ink:#2B2D31;--ink-2:#5F6165;--ink-3:#8A867F;
  --acc:#8D321F;--acc-2:#A94229;--acc-wash:#F6E7E2;--olive:#3A4027;--brick:#B25720;
  --r:16px;--r-sm:10px;
  display:flex;flex-direction:column;
  background:var(--bg);color:var(--ink);border:1px solid var(--line-2);border-radius:var(--r);
  font-family:Onest,"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.45;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;
}
.wrap.isPanel{
  position:fixed;right:18px;bottom:18px;z-index:2147483600;
  width:min(1040px,calc(100vw - 36px));max-height:calc(100vh - 36px);
  box-shadow:0 1px 2px rgba(43,45,49,.06),0 24px 60px -30px rgba(43,45,49,.5);
}
.wrap.isPanel.isMin{width:auto;max-width:420px}
.top{display:flex;align-items:center;gap:10px;padding:11px 14px;background:var(--surface);
  border-bottom:1px solid var(--line);border-radius:var(--r) var(--r) 0 0}
.mark{width:22px;height:22px;border-radius:7px;flex:none;background:linear-gradient(135deg,#8D321F,#7D4047)}
.ttl{font-weight:600;letter-spacing:-.015em}
.who{color:var(--ink-2);font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who b{color:var(--ink)}
.dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--olive)}
.dot.warn{background:var(--acc)}
.dot.down{background:var(--brick)}
.dot.off{background:var(--ink-3)}
.spacer{margin-left:auto}
button{font:inherit;cursor:pointer}
.btn{border:1px solid var(--line-2);background:var(--surface);color:var(--ink-2);border-radius:999px;
  padding:6px 14px;font-size:13px;transition:border-color .15s,color .15s,background .15s}
.btn:hover{border-color:var(--ink-3);color:var(--ink)}
.btn.pri{background:var(--acc);border-color:var(--acc);color:#FBF9F6;font-weight:600}
.btn.pri:hover{background:var(--acc-2);border-color:var(--acc-2)}
.btn:disabled{opacity:.5;cursor:default}
.btn.icon{padding:5px 9px;font-size:12.5px}
.body{padding:14px;overflow:auto}
.note{background:var(--acc-wash);border:1px solid #E2C6BC;border-radius:var(--r-sm);
  padding:10px 12px;margin-bottom:12px;font-size:13px}
.note.calm{background:var(--surface);border-color:var(--line)}
.note b{display:block;margin-bottom:2px}
.note .btn{margin-top:8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-sm);padding:10px 12px}
.tile .n{font-size:26px;font-weight:600;letter-spacing:-.02em}
.tile .l{font-size:11.5px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em}
.tile.err .n{color:var(--brick)}
.acts{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
input,select{font:inherit;font-size:13px;color:var(--ink);background:var(--surface);
  border:1px solid var(--line-2);border-radius:9px;padding:6px 9px}
input:focus,select:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-wash)}
input.q{flex:1 1 200px}
/* Фиксированная раскладка: длинные имена файлов не должны вытеснять кнопки. */
table{width:100%;min-width:900px;border-collapse:collapse;font-size:13px;table-layout:fixed}
th{text-align:left;font-size:11px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em;
  font-weight:600;padding:0 8px 6px;border-bottom:1px solid var(--line)}
td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
td.nw{white-space:nowrap}
td .cell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#rows{overflow-x:auto}
tr:hover td{background:var(--surface)}
.fio{font-weight:600}
.sub{color:var(--ink-3);font-size:12px}
.st{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;
  background:var(--surface-2);color:var(--ink-2);white-space:nowrap}
.st.ok{background:#E8EADF;color:var(--olive)}
.st.err{background:#F6E1D6;color:var(--brick)}
.st.warn{background:var(--acc-wash);color:var(--acc)}
.rowacts{display:flex;gap:6px;justify-content:flex-end;white-space:nowrap}
.empty{padding:26px 10px;text-align:center;color:var(--ink-3)}
.cfg{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;
  background:var(--surface);border:1px solid var(--line);border-radius:var(--r-sm);padding:12px;margin-bottom:12px}
.cfg label{display:block;font-size:11.5px;color:var(--ink-3);margin-bottom:4px}
.cfg .chk{display:flex;gap:8px;align-items:center;font-size:13px;color:var(--ink-2);margin-top:18px}
.hint{font-size:12px;color:var(--ink-3);margin-top:8px}
.paths{font-size:12px;color:var(--ink-3);margin-bottom:12px}
.paths b{color:var(--ink-2);font-weight:600}
`;

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_CLASS = { saved: 'ok', no_fio: 'warn', duplicate: '', error: 'err' };

/** «Щенников Алексей Дмитриевич» → «Щенников А. Д.»: колонка ФУ узкая. */
function shortFio(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return name || '';
  return parts[0] + ' ' + parts.slice(1).map((p) => p[0].toUpperCase() + '.').join(' ');
}

/** «2026-09-15T10:01:53+05:00» → «15.09.2026». */
function dateOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

const UI = {
  root: null,
  shadow: null,
  mode: 'page',
  min: false,
  cfgOpen: false,
  filters: { q: '', date: '', status: '', manager: '' },

  mount(mode, host) {
    this.mode = mode || 'page';
    this.root = document.createElement('div');
    this.root.id = 'nsis-auto-panel';
    this.shadow = this.root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    this.shadow.append(style, wrap);
    this.wrap = wrap;
    (host || document.body).appendChild(this.root);

    wrap.addEventListener('click', (e) => this.onClick(e));
    wrap.addEventListener('input', (e) => this.onInput(e));
    wrap.addEventListener('change', (e) => this.onChange(e));

    Core.on(() => this.render());
    this.render();
  },

  onClick(e) {
    const btn = e.target.closest('[data-do]');
    if (!btn) return;
    const { do: action, id } = btn.dataset;
    const run = {
      check: () => Core.tick(),
      auto: () => (Core.state.auto ? Core.stopAuto() : Core.startAuto()),
      folder: () => (Core.state.folder === 'denied' ? Core.grant('folder') : Core.pick('folder')),
      inbox: () => (Core.state.inbox === 'denied' ? Core.grant('inbox') : Core.pick('inbox')),
      diag: () => this.showDiag(),
      cfg: () => {
        this.cfgOpen = !this.cfgOpen;
        this.render();
      },
      min: () => {
        this.min = !this.min;
        this.render();
      },
      close: () => this.root.remove(),
      again: () => Core.again(id),
      open: () => Core.openFile(Core.state.entries.find((x) => x.requestId === id)),
      path: () => {
        const entry = Core.state.entries.find((x) => x.requestId === id);
        if (entry) navigator.clipboard.writeText(entry.path || entry.fileName || '');
      },
    }[action];
    if (run) Promise.resolve(run()).catch((err) => console.warn('[НСИС]', err));
  },

  /*
   * Отчёт показываем прямо в панели и кладём в буфер: на рабочем компьютере
   * консоль открывать неудобно, а переслать текст — просто.
   */
  async showDiag() {
    const host = this.wrap.querySelector('#rows');
    if (host) host.insertAdjacentHTML('beforebegin', '<div class="note calm" id="diag"><b>Собираем отчёт…</b></div>');
    let text;
    try {
      text = await report();
    } catch (e) {
      text = 'Диагностика не собралась: ' + ((e && e.message) || e);
    }
    let copied = '';
    try {
      await navigator.clipboard.writeText(text);
      copied = ' Он уже в буфере обмена — можно вставить в переписку.';
    } catch {
      copied = ' Выделите текст и скопируйте вручную.';
    }
    const box = this.wrap.querySelector('#diag');
    if (box) {
      box.innerHTML =
        `<b>Отчёт о состоянии</b>Личных данных в нём нет: строки с русскими буквами заменены на пометку о длине.${copied}` +
        `<textarea readonly style="width:100%;height:220px;margin-top:8px;font:12px/1.45 ui-monospace,Consolas,monospace;` +
        `border:1px solid var(--line-2);border-radius:9px;padding:8px;background:var(--surface);color:var(--ink)"></textarea>`;
      box.querySelector('textarea').value = text;
    }
  },

  onInput(e) {
    if (e.target.dataset.filter) {
      this.filters[e.target.dataset.filter] = e.target.value;
      this.renderRows();
    }
  },

  onChange(e) {
    const { filter, cfg } = e.target.dataset;
    if (filter) {
      this.filters[filter] = e.target.value;
      this.renderRows();
    }
    if (cfg) {
      const value = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
      Core.saveSettings({ [cfg]: value });
    }
  },

  rows() {
    const { q, date, status, manager } = this.filters;
    const needle = q.trim().toLowerCase();
    return Core.state.entries.filter((e) => {
      if (status && e.status !== status) return false;
      if (manager && (e.manager || '') !== manager) return false;
      if (date && e.day !== date) return false;
      if (!needle) return true;
      const hay = `${(e.fio || []).join(' ')} ${e.fileName || ''} ${e.caseNo || ''}`.toLowerCase();
      return hay.includes(needle);
    });
  },

  statusLine(s) {
    if (s.mode === 'panel') {
      return s.nsis === 'ok'
        ? { text: 'НСИС в порядке', dot: '' }
        : s.nsis === 'session'
        ? { text: 'Сессия истекла', dot: 'warn' }
        : s.nsis === 'down'
        ? { text: 'НСИС недоступна', dot: 'down' }
        : { text: 'проверяем…', dot: 'off' };
    }
    if (s.inbox !== 'ready') return { text: 'папка загрузок не указана', dot: 'warn' };
    return s.auto
      ? { text: `следим за папкой загрузок`, dot: '' }
      : { text: 'слежение остановлено', dot: 'off' };
  },

  render() {
    const s = Core.state;
    const st = this.statusLine(s);
    const c = Core.counters();

    this.wrap.className = `wrap${this.mode === 'panel' ? ' isPanel' : ' isPage'}${this.min ? ' isMin' : ''}`;
    this.wrap.innerHTML = `
      <div class="top">
        ${this.mode === 'panel' ? '<span class="mark"></span><span class="ttl">НСИС — ответы</span>' : ''}
        <span class="dot ${st.dot}"></span>
        <span class="who">${esc(st.text)}${s.manager ? ' · <b>' + esc(s.manager) + '</b>' : ''}</span>
        <span class="spacer"></span>
        ${this.min ? `<span class="who">${c.saved} сегодня · ${c.errors} ошибок</span>` : ''}
        ${
          this.mode === 'panel'
            ? `<button class="btn icon" data-do="min">${this.min ? 'Развернуть' : 'Свернуть'}</button>
               <button class="btn icon" data-do="close">×</button>`
            : ''
        }
      </div>
      ${this.min ? '' : `<div class="body">${this.bodyHtml(s, c)}</div>`}
    `;
    if (!this.min) this.renderRows();
  },

  notesHtml(s) {
    const notes = [];
    if (s.folder === 'unsupported') {
      notes.push(
        `<div class="note"><b>Запись в папку недоступна</b>Браузер или политика запрещают странице писать на диск, поэтому файлы сохраняются в «Загрузки» — уже с правильными именами, но без раскладки по дням.</div>`
      );
    } else {
      const needInbox = this.mode === 'page' && s.inbox === 'none';
      if (s.folder === 'none' && needInbox) {
        // При первом запуске незачем пугать двумя предупреждениями подряд.
        notes.push(
          `<div class="note"><b>Осталось указать две папки</b>
           <b style="display:inline;font-weight:600">Куда складывать</b> — например «Рабочий стол\\НСИС»: внутри появятся папки по дням.
           <b style="display:inline;font-weight:600">Откуда брать</b> — папка загрузок браузера: страница будет сама забирать оттуда новые ответы.
           <br><button class="btn" data-do="folder">Папка НСИС</button> <button class="btn" data-do="inbox">Папка загрузок</button></div>`
        );
      } else if (s.folder === 'none') {
        notes.push(
          `<div class="note"><b>Куда складывать — не указано</b>Нажмите «Папка НСИС» и выберите, например, «Рабочий стол\\НСИС». Внутри появятся папки по дням. Пока папка не выбрана, файлы падают в «Загрузки» без раскладки.<br><button class="btn" data-do="folder">Папка НСИС</button></div>`
        );
      }
      if (s.folder === 'denied') {
        notes.push(
          `<div class="note"><b>Подтвердите доступ к папке НСИС</b>Браузер спрашивает разрешение один раз за сеанс.<br><button class="btn" data-do="folder">Подтвердить</button></div>`
        );
      }
      if (needInbox && s.folder !== 'none') {
        notes.push(
          `<div class="note"><b>Откуда брать ответы — не указано</b>Нажмите «Папка загрузок» и укажите папку, куда браузер сохраняет файлы (если поставлено расширение — «Загрузки\\nsis-inbox»). Страница будет сама забирать оттуда новые PDF. Файлы можно и просто перетащить сюда.<br><button class="btn" data-do="inbox">Папка загрузок</button></div>`
        );
      }
      if (this.mode === 'page' && s.inbox === 'denied') {
        notes.push(
          `<div class="note"><b>Подтвердите доступ к папке загрузок</b>Разрешение спрашивается один раз за сеанс браузера.<br><button class="btn" data-do="inbox">Подтвердить</button></div>`
        );
      }
    }
    if (this.mode === 'panel' && s.nsis === 'session') {
      notes.push(
        `<div class="note"><b>Сессия НСИС истекла</b>Войдите в личный кабинет по УКЭП в этой же вкладке — приложение само заметит новую сессию, определит ФУ и продолжит с того места, где остановилось.</div>`
      );
    }
    if (this.mode === 'page' && s.nsis === 'blocked') {
      notes.push(
        `<div class="note calm"><b>Из этой страницы в НСИС не дотянуться</b>Так устроен браузер: сессия кабинета принадлежит его адресу, и чужой странице её не отдают. Поэтому ответы берём из папки. Чтобы они забирались автоматически, поставьте закладку — раздел «Забирать из НСИС автоматически» ниже.</div>`
      );
    }
    if (s.lastError && s.nsis !== 'session' && s.nsis !== 'blocked') {
      notes.push(`<div class="note"><b>${esc(s.lastError)}</b>Проверка повторится автоматически.</div>`);
    }
    return notes.join('');
  },

  bodyHtml(s, c) {
    const managers = [...new Set(Core.state.entries.map((e) => e.manager).filter(Boolean))];
    const panel = this.mode === 'panel';
    return `
      ${this.notesHtml(s)}
      <div class="tiles">
        <div class="tile"><div class="n">${s.busy ? '…' : c.news}</div><div class="l">${panel ? 'новых ответов' : 'в работе'}</div></div>
        <div class="tile"><div class="n">${c.saved}</div><div class="l">разложено сегодня</div></div>
        <div class="tile ${c.errors ? 'err' : ''}"><div class="n">${c.errors}</div><div class="l">ошибок</div></div>
        <div class="tile"><div class="n">${c.skipped}</div><div class="l">пропущено</div></div>
      </div>
      <div class="acts">
        <button class="btn pri" data-do="check" ${s.busy ? 'disabled' : ''}>${
          s.busy ? 'Работаем…' : panel ? 'Проверить сейчас' : 'Проверить папку'
        }</button>
        <button class="btn" data-do="auto">${
          s.auto ? (panel ? 'Остановить автопроверку' : 'Остановить слежение') : panel ? 'Включить автопроверку' : 'Включить слежение'
        }</button>
        ${panel ? '' : `<button class="btn" data-do="inbox">${s.inbox === 'ready' ? 'Сменить папку загрузок' : 'Папка загрузок'}</button>`}
        <button class="btn" data-do="folder">${s.folder === 'ready' ? 'Сменить папку НСИС' : 'Папка НСИС'}</button>
        <button class="btn" data-do="cfg">Настройки</button>
        <button class="btn" data-do="diag">Диагностика</button>
      </div>
      ${this.cfgOpen ? this.cfgHtml(panel) : ''}
      <div class="filters">
        <input class="q" data-filter="q" placeholder="Поиск по ФИО, делу или имени файла" value="${esc(this.filters.q)}">
        <input type="text" data-filter="date" placeholder="день: ${folderForDay(new Date())}" value="${esc(this.filters.date)}" style="width:150px">
        <select data-filter="status">
          <option value="">все статусы</option>
          ${Object.entries(STATUS)
            .map(([k, v]) => `<option value="${k}" ${this.filters.status === k ? 'selected' : ''}>${esc(v)}</option>`)
            .join('')}
        </select>
        <select data-filter="manager">
          <option value="">все ФУ</option>
          ${managers.map((m) => `<option ${this.filters.manager === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        </select>
      </div>
      <div id="rows"></div>
      <div class="hint">${
        panel
          ? `Автопроверка работает, пока эта вкладка открыта${s.auto ? `, каждые ${Core.settings.intervalMin} мин` : ''}.`
          : `Слежение за папкой работает, пока открыта эта страница${s.auto ? `, проверка каждые ${Core.settings.watchSec} с` : ''}.`
      } Последняя проверка: ${s.lastCheck ? esc(new Date(s.lastCheck).toLocaleTimeString('ru-RU')) : '—'}.</div>
    `;
  },

  cfgHtml(panel) {
    const s = Core.settings;
    return `
      <div class="cfg">
        ${
          panel
            ? `<div><label>Интервал автопроверки, мин</label><input type="number" min="1" max="600" data-cfg="intervalMin" value="${s.intervalMin}"></div>
               <div><label>Параллельных загрузок</label><input type="number" min="1" max="8" data-cfg="concurrency" value="${s.concurrency}"></div>
               <div><label>Страниц журнала за проверку</label><input type="number" min="1" max="20" data-cfg="deepPages" value="${s.deepPages}"></div>`
            : `<div><label>Проверять папку раз в, секунд</label><input type="number" min="3" max="600" data-cfg="watchSec" value="${s.watchSec}"></div>`
        }
        <div><label>Повторов при ошибке</label><input type="number" min="1" max="10" data-cfg="retries" value="${s.retries}"></div>
        <label class="chk"><input type="checkbox" data-cfg="withCase" ${s.withCase ? 'checked' : ''}> номер дела в имени файла</label>
        ${
          panel
            ? ''
            : `<label class="chk"><input type="checkbox" data-cfg="moveFromInbox" ${s.moveFromInbox ? 'checked' : ''}> убирать разложенное из папки загрузок</label>`
        }
      </div>
    `;
  },

  renderRows() {
    const host = this.wrap.querySelector('#rows');
    if (!host) return;
    const rows = this.rows();
    if (!rows.length) {
      host.innerHTML = `<div class="empty">${
        this.mode === 'panel'
          ? 'Пока ничего нет. Нажмите «Проверить сейчас» — приложение пройдёт журнал обращений и заберёт готовые ответы.'
          : 'Пока ничего нет. Скачайте ответы в НСИС как обычно или перетащите PDF на эту страницу.'
      }</div>`;
      return;
    }
    host.innerHTML = `
      <table>
        <colgroup>
          <col><col style="width:126px"><col style="width:94px"><col style="width:190px">
          <col style="width:132px"><col style="width:118px"><col style="width:142px">
        </colgroup>
        <thead><tr>
          <th>Должник</th><th>Дело</th><th>Ответ</th><th>Файл</th><th>ФУ</th><th>Статус</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.map((e) => this.rowHtml(e)).join('')}
        </tbody>
      </table>`;
  },

  rowHtml(e) {
    // У ошибки ФИО ещё неизвестно — там нечего писать, «Не определено» только
    // у сохранённых файлов, у которых разбор не дал результата.
    const fio = (e.fio || []).join(', ') || (e.status === 'error' ? '—' : 'Не определено');
    const birth = e.birth && Object.values(e.birth)[0] ? Object.values(e.birth)[0] : '';
    const st = STATUS[e.status] || e.status;
    return `
      <tr>
        <td><div class="fio">${esc(fio)}</div>${birth ? `<div class="sub">${esc(birth)} г. р.</div>` : ''}</td>
        <td class="nw">${esc(e.caseNo || '—')}</td>
        <td class="nw">${esc(e.answerDate || dateOf(e.createDate) || '—')}</td>
        <td class="file">${
          e.fileName
            ? `<div class="cell" title="${esc(e.fileName)}">${esc(e.fileName)}</div><div class="cell sub" title="${esc(e.path || '')}">${esc(e.path || '')}</div>`
            : '<span class="sub">—</span>'
        }</td>
        <td class="fu"><div class="cell" title="${esc(e.manager || '')}">${esc(shortFio(e.manager) || '—')}</div></td>
        <td><span class="st ${STATUS_CLASS[e.status] || ''}">${esc(st)}</span>
          ${e.error ? `<div class="sub">${esc(e.error)}${e.attempts ? `, попыток: ${e.attempts}` : ''}</div>` : ''}</td>
        <td><div class="rowacts">
          ${e.fileName && e.place === 'folder' && Core.state.folder === 'ready' ? `<button class="btn icon" data-do="open" data-id="${esc(e.requestId)}">Открыть</button>` : ''}
          ${e.path ? `<button class="btn icon" data-do="path" data-id="${esc(e.requestId)}" title="Скопировать путь к файлу">Путь</button>` : ''}
          <button class="btn icon" data-do="again" data-id="${esc(e.requestId)}" title="Сделать ещё одну копию файла">Ещё раз</button>
        </div></td>
      </tr>`;
  },
};

/*
 * Точка входа. Один и тот же файл запускается в двух местах:
 *
 *   — на странице-приложении (в разметке есть #nsis-app) — тогда это рабочее
 *     место: папки, журнал, разбор, раскладка;
 *   — на странице личного кабинета НСИС, куда его приносит закладка или
 *     сниппет DevTools, — тогда это панель поверх кабинета, которая умеет ещё
 *     и забирать ответы сама.
 *
 * Повторный запуск не плодит панели.
 */

(async function boot() {
  const onNsis = /(^|\.)nsis\.ru$/.test(location.hostname);
  const host = document.getElementById('nsis-app');
  if (!onNsis && !host) {
    alert('Эту закладку нужно нажимать на странице личного кабинета НСИС: https://lk.nsis.ru/requestLog/');
    return;
  }
  const mode = onNsis ? 'panel' : 'page';

  if (window.__nsisAuto) {
    if (!document.getElementById('nsis-auto-panel')) window.__nsisAuto.ui.mount(mode, host);
    return;
  }
  window.__nsisAuto = { core: Core, ui: UI };
  UI.mount(mode, host);

  if (mode === 'page') {
    // Перетаскивание — путь без всяких разрешений: работает даже там, где
    // доступ к папкам закрыт политикой.
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('dragover', stop);
    document.addEventListener('drop', (e) => {
      stop(e);
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        Core.addFiles(e.dataTransfer.files);
      }
    });
  }

  try {
    await Core.start(mode);
    // Со страницы-приложения кабинет, скорее всего, недоступен — но проверим
    // фактом, а не предположением, и скажем честно, что вышло.
    if (mode === 'page') await Core.probeNsis();
  } catch (e) {
    console.error('[НСИС] не удалось запустить', e);
    alert('Не удалось запустить: ' + (e && e.message ? e.message : e));
  }
})();

})();
