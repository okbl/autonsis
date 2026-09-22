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

import { Nsis, answerOf, statusCodeOf, managerName } from './api.js';
import { Store, Folder, Inbox, sha256, downloadBlob } from './store.js';
import { pdfPagesText, browserInflate } from './pdftext.js';
import { parseAnswer } from './parse.js';
import { fileNameFor, folderForDay, withCopyIndex } from './name.js';

export const HUMAN = {
  network: 'НСИС недоступна',
  blocked: 'НСИС доступен только со страницы кабинета',
  session: 'Сессия истекла',
  http: 'Ошибка скачивания',
  pdf: 'Ошибка скачивания',
  read: 'Не удалось прочитать файл',
  write: 'Не удалось сохранить файл',
  no_fio: 'Не удалось определить ФИО',
};

export const STATUS = {
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export const Core = {
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
          const result = await this.intake(bytes, { source: file.name });
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
          await this.intake(bytes, { source: file.name });
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
      placed = { ...(await Folder.write(day, name, blob, withCopyIndex)), place: 'folder' };
    } else {
      const flat = withCopyIndex(name, prev.copies || 0);
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
