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
export async function pdfPagesText(bytes, inflate, maxPages = 3) {
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
export async function browserInflate(u8) {
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
