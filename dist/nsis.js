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

const Folder = {
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
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'nsis-root' });
    this.handle = handle;
    return handle;
  },

  async grant() {
    if (!this.handle) return false;
    if ((await this.handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await this.handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  },

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
    const file = await this.handle.getFileHandle('журнал.json', { create: true });
    const stream = await file.createWritable();
    await stream.write(new Blob([JSON.stringify(rows, null, 1)], { type: 'application/json' }));
    await stream.close();
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
 * Ядро: очередь, повторы, автопроверка, состояние.
 *
 * Правила, которые здесь важнее всего:
 *   — ошибка одного ответа не трогает остальные: она остаётся в его записи;
 *   — уже обработанное обращение второй раз не скачивается (ключ — requestId,
 *     он известен до скачивания, в отличие от hash содержимого);
 *   — hash — второй уровень: ловит тот же ответ, пришедший другим обращением;
 *   — после простоя приложение проходит журнал обращений целиком и берёт всё,
 *     чего нет у себя, поэтому неважно, сколько вкладка была закрыта.
 */

const HUMAN = {
  network: 'НСИС недоступна',
  session: 'Сессия истекла',
  http: 'Ошибка скачивания',
  pdf: 'Ошибка скачивания',
  write: 'Не удалось сохранить файл',
  no_fio: 'Не удалось определить ФИО',
};

const STATUS = {
  saved: 'Скачано',
  no_fio: 'ФИО не определено',
  duplicate: 'Пропущено (дубликат)',
  error: 'Ошибка',
};

const DEFAULTS = {
  intervalMin: 15,
  concurrency: 4,
  retries: 3,
  withCase: true,
  deepPages: 4, // сколько страниц журнала обращений просматривать (по 50)
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const Core = {
  settings: { ...DEFAULTS },
  state: {
    manager: null,
    profileName: null,
    nsis: 'unknown', // unknown | ok | session | down
    auto: true,
    busy: false,
    lastCheck: null,
    lastError: null,
    folder: 'none', // none | ready | denied | unsupported | downloads
    news: 0,
    entries: [],
  },
  listeners: new Set(),

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  emit() {
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch (e) {
        console.error('[НСИС] ошибка обновления панели', e);
      }
    }
  },

  async start() {
    await Store.init();
    const saved = await Store.meta('settings');
    if (saved) this.settings = { ...DEFAULTS, ...saved };
    const autoSaved = await Store.meta('auto');
    this.state.auto = autoSaved === null ? true : !!autoSaved;

    if (!Folder.supported()) {
      this.state.folder = 'unsupported';
    } else {
      const handle = await Store.meta('folder');
      const ok = handle ? await Folder.restore(handle) : null;
      this.state.folder = ok ? 'ready' : handle ? 'denied' : 'none';
    }

    await this.reload();
    this.emit();
    if (this.state.auto) this.startAuto();
    this.checkNow();
    return this;
  },

  async saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    await Store.meta('settings', this.settings);
    if (patch.intervalMin && this.state.auto) this.startAuto();
    this.emit();
  },

  startAuto() {
    this.stopAuto(true);
    this.state.auto = true;
    Store.meta('auto', true);
    this.timer = setInterval(() => this.checkNow(), Math.max(1, this.settings.intervalMin) * 60000);
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

  async pickFolder() {
    const handle = await Folder.pick();
    await Store.meta('folder', handle);
    this.state.folder = 'ready';
    this.emit();
  },

  async grantFolder() {
    const ok = await Folder.grant();
    this.state.folder = ok ? 'ready' : 'denied';
    this.emit();
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

  /** Журнал обращений НСИС целиком (пока страницы не кончатся). */
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

  async checkNow() {
    if (this.state.busy) return;
    this.state.busy = true;
    this.state.lastError = null;
    this.emit();
    try {
      const profile = await Nsis.profile();
      this.state.profileName = managerName(profile);
      this.state.manager = this.state.profileName || this.state.manager;
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
          todo.push({ query: q, pdf, retry: true });
        }
      }
      this.state.news = todo.length;
      this.emit();

      await this.runQueue(todo);
      this.state.lastCheck = new Date().toISOString();
    } catch (e) {
      this.state.nsis = e.code === 'session' ? 'session' : 'down';
      this.state.lastError = HUMAN[e.code] || 'Неизвестная ошибка';
    } finally {
      // Кнопка должна отпускаться сразу, не дожидаясь перечитывания журнала.
      this.state.busy = false;
      this.emit();
      await this.reload();
      this.state.news = 0;
      this.emit();
      this.mirrorJournal();
    }
  },

  async runQueue(items) {
    const queue = items.slice();
    const workers = Array.from({ length: Math.max(1, Math.min(8, this.settings.concurrency)) }, async () => {
      while (queue.length) {
        if (this.state.nsis === 'session') return;
        const item = queue.shift();
        await this.processOne(item);
        await this.reload();
        this.emit();
      }
    });
    await Promise.all(workers);
  },

  async processOne({ query, pdf }, force = false) {
    const requestId = query.requestId;
    const prev = (await Store.get(requestId)) || {};
    let attempts = prev.attempts || 0;
    const maxTries = Math.max(1, this.settings.retries);

    for (let tryNo = 0; tryNo < maxTries; tryNo++) {
      attempts++;
      try {
        const blob = await Nsis.answerPdf(pdf);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const hash = await sha256(bytes);

        if (!force) {
          const twin = await Store.byHash(hash);
          if (twin && twin.requestId !== requestId) {
            await Store.put({
              requestId,
              hash,
              status: 'duplicate',
              duplicateOf: twin.requestId,
              fio: twin.fio || [],
              caseNo: twin.caseNo || null,
              manager: this.state.manager,
              answerDate: twin.answerDate || null,
              createDate: query.createDate || null,
              pdfRef: pdf,
              attempts,
              savedAt: new Date().toISOString(),
            });
            return;
          }
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
        let placed;
        if (this.state.folder === 'ready') {
          placed = { ...(await Folder.write(day, name, blob, withCopyIndex)), place: 'folder' };
        } else {
          const flat = withCopyIndex(name, prev.copies || 0);
          downloadBlob(blob, flat);
          placed = { name: flat, place: 'downloads' };
        }

        await Store.put({
          requestId,
          status: parsed.fio.length ? 'saved' : 'no_fio',
          queryStatus: statusCodeOf(query) || null,
          fio: parsed.fio,
          birth: parsed.birth,
          caseNo: parsed.caseNo,
          answerDate: parsed.answerDate,
          createDate: query.createDate || null,
          manager: parsed.manager || this.state.manager,
          fileName: placed.name,
          // День всегда датой: по нему считается «скачано сегодня» и работает
          // фильтр, даже когда файл ушёл в «Загрузки» без раскладки по папкам.
          day,
          place: placed.place,
          path: `${placed.place === 'folder' ? day : 'Загрузки'}\\${placed.name}`,
          hash,
          size: bytes.length,
          attempts,
          error: parsed.fio.length ? null : parseFailed ? HUMAN.pdf : HUMAN.no_fio,
          copies: (prev.copies || 0) + (force ? 1 : 0),
          pdfRef: pdf,
          savedAt: new Date().toISOString(),
        });
        return;
      } catch (e) {
        const code = e.code || 'write';
        const human = HUMAN[code] || 'Ошибка скачивания';
        // Разрешение на папку могли отозвать — покажем это в панели.
        if (code === 'write' && this.state.folder === 'ready') this.state.folder = 'denied';
        await Store.addAttempt(requestId, human);
        if (code === 'session') {
          this.state.nsis = 'session';
          const kept = prev.status === 'saved' || prev.status === 'no_fio';
          await Store.put({
            ...prev,
            requestId,
            status: kept ? prev.status : 'error',
            error: human,
            errorCode: code,
            attempts,
            pdfRef: pdf,
            savedAt: prev.savedAt || new Date().toISOString(),
          });
          return;
        }
        if (tryNo === maxTries - 1) {
          // Файл, сохранённый раньше, остаётся сохранённым: неудачная
          // повторная загрузка не должна стирать его из журнала.
          const keep = prev.status === 'saved' || prev.status === 'no_fio';
          await Store.put({
            ...prev,
            requestId,
            status: keep ? prev.status : 'error',
            error: human,
            errorCode: code,
            attempts,
            pdfRef: pdf,
            createDate: query.createDate || null,
            manager: this.state.manager,
            savedAt: prev.savedAt || new Date().toISOString(),
          });
          return;
        }
        await sleep(Math.min(15000, 1000 * 2 ** tryNo));
      }
    }
  },

  /** «Скачать повторно» — всегда создаёт новый файл рядом. */
  async redownload(requestId) {
    const entry = await Store.get(requestId);
    if (!entry || !entry.pdfRef) return;
    if (this.state.folder === 'denied') await this.grantFolder();
    this.state.busy = true;
    this.emit();
    try {
      await this.processOne({ query: { requestId, createDate: entry.createDate }, pdf: entry.pdfRef }, true);
    } finally {
      this.state.busy = false;
      this.emit();
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

  async mirrorJournal() {
    if (this.state.folder !== 'ready') return;
    try {
      await Folder.writeJournal(
        this.state.entries.map((e) => ({
          ФИО: (e.fio || []).join(', ') || 'Не определено',
          деньРождения: e.birth || {},
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
          сохранено: e.savedAt || '',
        }))
      );
    } catch (e) {
      console.warn('[НСИС] копию журнала записать не удалось', e);
    }
  },
};

/*
 * Панель поверх страницы личного кабинета.
 *
 * Живёт в shadow-root: стили НСИС на неё не влияют, а наши — на НСИС.
 * Оформление — как в ОКБ-анализаторе: алебастровый фон, тёплый грейж
 * поверхностей, угольный текст, терракота как единственный акцент, плитки,
 * табличные цифры. Цвет несёт смысл: терракота — требует внимания,
 * кирпичный — ошибка, олива — «в порядке».
 *
 * Шрифт Onest в закладку не встроить (это был бы лишний мегабайт в URL),
 * поэтому он берётся системный, если установлен, иначе Segoe UI.
 */

const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.wrap{
  --bg:#F1ECE6;--surface:#FBF9F6;--surface-2:#E7E0D8;--line:#DDD5CD;--line-2:#C6BCB1;
  --ink:#2B2D31;--ink-2:#5F6165;--ink-3:#8A867F;
  --acc:#8D321F;--acc-2:#A94229;--acc-wash:#F6E7E2;--olive:#3A4027;--brick:#B25720;
  --r:16px;--r-sm:10px;
  position:fixed;right:18px;bottom:18px;z-index:2147483600;
  width:min(1040px,calc(100vw - 36px));max-height:calc(100vh - 36px);
  display:flex;flex-direction:column;
  background:var(--bg);color:var(--ink);border:1px solid var(--line-2);border-radius:var(--r);
  box-shadow:0 1px 2px rgba(43,45,49,.06),0 24px 60px -30px rgba(43,45,49,.5);
  font-family:Onest,"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.45;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;
}
.wrap.isMin{width:auto;max-width:420px}
.top{display:flex;align-items:center;gap:10px;padding:11px 14px;background:var(--surface);
  border-bottom:1px solid var(--line);border-radius:var(--r) var(--r) 0 0}
.mark{width:22px;height:22px;border-radius:7px;flex:none;background:linear-gradient(135deg,#8D321F,#7D4047)}
.ttl{font-weight:600;letter-spacing:-.015em}
.who{color:var(--ink-2);font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who b{color:var(--ink)}
.dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--olive)}
.dot.warn{background:var(--acc)}
.dot.down{background:var(--brick)}
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
.note b{display:block;margin-bottom:2px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-sm);padding:10px 12px}
.tile .n{font-size:26px;font-weight:600;letter-spacing:-.02em}
.tile .l{font-size:11.5px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em}
.tile.err .n{color:var(--brick)}
.acts{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
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
td:first-child{min-width:180px}
td:last-child{width:1%}
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
  min: false,
  cfgOpen: false,
  filters: { q: '', date: '', status: '', manager: '' },

  mount() {
    this.root = document.createElement('div');
    this.root.id = 'nsis-auto-panel';
    this.shadow = this.root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    this.shadow.append(style, wrap);
    this.wrap = wrap;
    document.body.appendChild(this.root);

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
      check: () => Core.checkNow(),
      auto: () => (Core.state.auto ? Core.stopAuto() : Core.startAuto()),
      folder: () => (Core.state.folder === 'denied' ? Core.grantFolder() : Core.pickFolder()),
      cfg: () => {
        this.cfgOpen = !this.cfgOpen;
        this.render();
      },
      min: () => {
        this.min = !this.min;
        this.render();
      },
      close: () => this.root.remove(),
      again: () => Core.redownload(id),
      open: () => Core.openFile(Core.state.entries.find((x) => x.requestId === id)),
      path: () => {
        const entry = Core.state.entries.find((x) => x.requestId === id);
        if (entry) navigator.clipboard.writeText(entry.path || entry.fileName || '');
      },
    }[action];
    if (run) Promise.resolve(run()).catch((err) => console.warn('[НСИС]', err));
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

  render() {
    const s = Core.state;
    const c = Core.counters();
    const status =
      s.nsis === 'ok' ? 'НСИС в порядке' : s.nsis === 'session' ? 'Сессия истекла' : s.nsis === 'down' ? 'НСИС недоступна' : 'проверяем…';
    const dotCls = s.nsis === 'ok' ? '' : s.nsis === 'session' ? 'warn' : 'down';

    this.wrap.className = `wrap${this.min ? ' isMin' : ''}`;
    this.wrap.innerHTML = `
      <div class="top">
        <span class="mark"></span>
        <span class="ttl">НСИС — ответы</span>
        <span class="dot ${dotCls}"></span>
        <span class="who">${esc(status)}${s.manager ? ' · <b>' + esc(s.manager) + '</b>' : ''}</span>
        <span class="spacer"></span>
        ${this.min ? `<span class="who">${c.saved} сегодня · ${c.errors} ошибок</span>` : ''}
        <button class="btn icon" data-do="min">${this.min ? 'Развернуть' : 'Свернуть'}</button>
        <button class="btn icon" data-do="close">×</button>
      </div>
      ${this.min ? '' : `<div class="body">${this.bodyHtml(s, c)}</div>`}
    `;
    if (!this.min) this.renderRows();
  },

  bodyHtml(s, c) {
    const notes = [];
    if (s.nsis === 'session') {
      notes.push(
        `<div class="note"><b>Сессия НСИС истекла</b>Войдите в личный кабинет по УКЭП в этой же вкладке — приложение само заметит новую сессию, определит ФУ и продолжит с того места, где остановилось.</div>`
      );
    }
    if (s.folder === 'none') {
      notes.push(
        `<div class="note"><b>Папка для файлов не выбрана</b>Нажмите «Выбрать папку» и укажите, например, «Рабочий стол\\НСИС». Внутри появятся папки по дням. Пока папка не выбрана, файлы будут падать в «Загрузки» без раскладки.</div>`
      );
    }
    if (s.folder === 'denied') {
      notes.push(
        `<div class="note"><b>Нужно подтвердить доступ к папке</b>Браузер спрашивает разрешение один раз за сеанс — нажмите «Подтвердить папку».</div>`
      );
    }
    if (s.folder === 'unsupported') {
      notes.push(
        `<div class="note"><b>Запись в папку недоступна</b>Браузер или политика запрещают странице писать в папки, поэтому файлы сохраняются в «Загрузки» — уже с правильными именами, но без раскладки по дням.</div>`
      );
    }
    if (s.lastError && s.nsis !== 'session') notes.push(`<div class="note"><b>${esc(s.lastError)}</b>Проверка повторится автоматически.</div>`);

    const managers = [...new Set(Core.state.entries.map((e) => e.manager).filter(Boolean))];

    return `
      ${notes.join('')}
      <div class="tiles">
        <div class="tile"><div class="n">${s.busy ? '…' : c.news}</div><div class="l">новых ответов</div></div>
        <div class="tile"><div class="n">${c.saved}</div><div class="l">скачано сегодня</div></div>
        <div class="tile ${c.errors ? 'err' : ''}"><div class="n">${c.errors}</div><div class="l">ошибок</div></div>
        <div class="tile"><div class="n">${c.skipped}</div><div class="l">пропущено</div></div>
      </div>
      <div class="acts">
        <button class="btn pri" data-do="check" ${s.busy ? 'disabled' : ''}>${s.busy ? 'Проверяем…' : 'Проверить сейчас'}</button>
        <button class="btn" data-do="auto">${s.auto ? 'Остановить автопроверку' : 'Включить автопроверку'}</button>
        <button class="btn" data-do="folder">${s.folder === 'denied' ? 'Подтвердить папку' : s.folder === 'ready' ? 'Сменить папку' : 'Выбрать папку'}</button>
        <button class="btn" data-do="cfg">Настройки</button>
      </div>
      ${this.cfgOpen ? this.cfgHtml() : ''}
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
      <div class="hint">Автопроверка работает, пока эта вкладка открыта${s.auto ? `, каждые ${Core.settings.intervalMin} мин` : ''}. Последняя проверка: ${
        s.lastCheck ? esc(new Date(s.lastCheck).toLocaleTimeString('ru-RU')) : '—'
      }.</div>
    `;
  },

  cfgHtml() {
    const s = Core.settings;
    return `
      <div class="cfg">
        <div><label>Интервал автопроверки, мин</label><input type="number" min="1" max="600" data-cfg="intervalMin" value="${s.intervalMin}"></div>
        <div><label>Параллельных загрузок</label><input type="number" min="1" max="8" data-cfg="concurrency" value="${s.concurrency}"></div>
        <div><label>Повторов при ошибке</label><input type="number" min="1" max="10" data-cfg="retries" value="${s.retries}"></div>
        <div><label>Страниц журнала за проверку</label><input type="number" min="1" max="20" data-cfg="deepPages" value="${s.deepPages}"></div>
        <label class="chk"><input type="checkbox" data-cfg="withCase" ${s.withCase ? 'checked' : ''}> номер дела в имени файла</label>
      </div>
    `;
  },

  renderRows() {
    const host = this.wrap.querySelector('#rows');
    if (!host) return;
    const rows = this.rows();
    if (!rows.length) {
      host.innerHTML = `<div class="empty">Пока ничего нет. Нажмите «Проверить сейчас» — приложение пройдёт журнал обращений и заберёт готовые ответы.</div>`;
      return;
    }
    host.innerHTML = `
      <table>
        <colgroup>
          <col><col style="width:126px"><col style="width:94px"><col style="width:208px">
          <col style="width:112px"><col style="width:118px"><col style="width:142px">
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
          <button class="btn icon" data-do="again" data-id="${esc(e.requestId)}" title="Скачать повторно — создаст новый файл рядом">Ещё раз</button>
        </div></td>
      </tr>`;
  },
};

/*
 * Точка входа. Запускается на странице личного кабинета НСИС — закладкой
 * или сниппетом DevTools. Повторный запуск не плодит панели, а показывает
 * уже существующую.
 */

(async function boot() {
  const host = location.hostname;
  if (!/(^|\.)nsis\.ru$/.test(host)) {
    alert('Запускать нужно на странице личного кабинета НСИС: https://lk.nsis.ru/requestLog/');
    return;
  }
  if (window.__nsisAuto) {
    const panel = document.getElementById('nsis-auto-panel');
    if (panel) panel.scrollIntoView({ block: 'center' });
    else window.__nsisAuto.ui.mount();
    return;
  }
  window.__nsisAuto = { core: Core, ui: UI };
  UI.mount();
  try {
    await Core.start();
  } catch (e) {
    console.error('[НСИС] не удалось запустить', e);
    alert('Не удалось запустить: ' + (e && e.message ? e.message : e));
  }
})();

})();
