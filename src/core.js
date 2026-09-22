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

import { Nsis, answerOf, statusCodeOf, managerName } from './api.js';
import { Store, Folder, sha256, downloadBlob } from './store.js';
import { pdfPagesText, browserInflate } from './pdftext.js';
import { parseAnswer } from './parse.js';
import { fileNameFor, folderForDay, withCopyIndex } from './name.js';

export const HUMAN = {
  network: 'НСИС недоступна',
  session: 'Сессия истекла',
  http: 'Ошибка скачивания',
  pdf: 'Ошибка скачивания',
  write: 'Не удалось сохранить файл',
  no_fio: 'Не удалось определить ФИО',
};

export const STATUS = {
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

export const Core = {
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
