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

export const Store = {
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

export async function sha256(bytes) {
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

export const Folder = {
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

export const Inbox = {
  ...directory('nsis-inbox'),

  /*
   * Файлы верхнего уровня папки загрузок. Кроме PDF берём json и txt: в них
   * пользователь сохраняет список обращений из кабинета (Ctrl+S). Недокачанные
   * файлы браузера (.crdownload) по маске не проходят.
   */
  async listFiles() {
    if (!this.handle) return [];
    const files = [];
    for await (const [name, entry] of this.handle.entries()) {
      if (entry.kind !== 'file' || !/\.(pdf|json|txt)$/i.test(name)) continue;
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
export function downloadBlob(blob, name) {
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
