/*
 * Интерфейс. Один код в двух видах: страница-приложение (режим page) и
 * панель поверх кабинета НСИС (режим panel), куда его приносит закладка.
 * Живёт в shadow-root — стили кабинета на нас не влияют, наши на него тоже.
 *
 * Оформление снято с CSS кабинета НСИС: акцент #0A4FCA, фон #F2F5FA, текст
 * #2F3541, кнопки-пилюли, шрифт Onest. Цвет несёт смысл: зелёный —
 * разложено, янтарный — требует внимания, красный — ошибка.
 *
 * Главный экран — только данные: шапка, одна кнопка, поиск, журнал.
 * Всё, что нужно раз в месяц, живёт в настройках.
 */

import { Core, STATUS } from './core.js';
import { report } from './diag.js';
import { folderForDay } from './name.js';

const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.wrap{
  --blue:#0A4FCA;--blueDark:#003D99;--navy:#162F5A;--cello25:#1C2F5440;
  --ink:#2F3541;--ink-2:#575D69;--ink-3:#7E8492;
  --bg:#F2F5FA;--line:#ECEEF2;--line-2:#E6ECF5;
  --green:#09B37B;--greenBg:#E1F5EF;--greenInk:#0B7A56;
  --amber:#F38B00;--amberBg:#FDF1E0;--amberInk:#9A5A00;
  --red:#EB3333;--redBg:#FDEBEB;--redInk:#B32020;
  --shadow:0 8px 16px -4px #2f35411a,0 4px 8px 0 #2f35410d;
  --r:20px;--rLg:26px;--pill:999px;
  display:flex;flex-direction:column;gap:14px;
  background:transparent;color:var(--ink);
  font-family:Onest,"Segoe UI",system-ui,sans-serif;font-size:15px;line-height:1.5;
  font-variant-numeric:tabular-nums;
}
.wrap.isPanel{
  position:fixed;right:18px;bottom:18px;z-index:2147483600;
  width:min(1120px,calc(100vw - 36px));max-height:calc(100vh - 36px);overflow:auto;
  background:var(--bg);border-radius:var(--rLg);padding:14px;
  box-shadow:0 24px 60px -24px #16305a66,0 2px 8px #2f354114;
}
.wrap.isPanel.isMin{width:auto;max-width:460px}

.card{background:#fff;border-radius:var(--rLg);box-shadow:var(--shadow);padding:18px 20px}
.card.flat{padding:14px 18px}

/* ---------- шапка ---------- */
.top{display:flex;align-items:center;gap:13px;flex-wrap:wrap}
.sign{width:32px;height:32px;border-radius:10px;background:var(--navy);position:relative;flex:none}
.sign:after{content:"";position:absolute;inset:7px 7px auto 7px;height:4px;border-radius:2px;background:var(--blue)}
.sign:before{content:"";position:absolute;inset:auto 7px 6px 7px;height:9px;border-radius:3px;background:#ffffff40}
.ttl{font-weight:600;font-size:16px;letter-spacing:-.01em}
.state{margin-left:auto;display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--ink-2);min-width:0}
.state b{color:var(--ink)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex:none}
.dot.warn{background:var(--amber)}
.dot.down{background:var(--red)}
.dot.off{background:var(--ink-3)}

/* ---------- кнопки ---------- */
button{font:inherit}
.btn{display:inline-flex;align-items:center;gap:7px;border:1px solid transparent;border-radius:var(--pill);
  padding:10px 20px;font-size:14px;cursor:pointer;background:var(--blue);color:#fff;font-weight:600;
  transition:background .15s,border-color .15s,color .15s}
.btn:hover{background:var(--blueDark)}
.btn.sec{background:#fff;color:var(--ink);border-color:var(--cello25);font-weight:400}
.btn.sec:hover{border-color:var(--blue);color:var(--blue)}
.btn.sm{padding:7px 14px;font-size:13px}
.btn:disabled{opacity:.55;cursor:default}
.acts{display:flex;gap:10px;flex-wrap:wrap;align-items:center}

/* ---------- сообщения ---------- */
.note{border-radius:var(--r);padding:14px 18px;font-size:14px;background:#fff;box-shadow:var(--shadow)}
.note.attn{background:var(--amberBg);box-shadow:none;border:1px solid #f3c88a66}
.note.bad{background:var(--redBg);box-shadow:none;border:1px solid #f0b3b3}
.note b{display:block;margin-bottom:3px;color:var(--ink)}
.note .acts{gap:8px}
.steps{counter-reset:s;margin:10px 0 0;padding:0;list-style:none;display:grid;gap:6px}
.steps li{counter-increment:s;position:relative;padding-left:30px;color:var(--ink-2);font-size:14px}
.steps li:before{content:counter(s);position:absolute;left:0;top:1px;width:21px;height:21px;border-radius:50%;
  background:var(--line-2);color:var(--navy);font-size:12px;font-weight:600;display:grid;place-items:center}
.steps b{display:inline;color:var(--ink);font-weight:600}

/* ---------- фильтры ---------- */
.filters{display:flex;gap:10px;flex-wrap:wrap}
input,select{font:inherit;font-size:14px;color:var(--ink);background:#fff;border:1px solid var(--cello25);
  border-radius:var(--pill);padding:10px 16px;min-width:140px}
input:focus,select:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px #0a4fca1f}
input.q{flex:1 1 260px}

/* ---------- журнал ---------- */
.hdr,.row{display:grid;grid-template-columns:minmax(0,1.35fr) 150px 104px minmax(0,1.3fr) max-content;gap:14px;align-items:center}
.hdr>*,.row>*{min-width:0}
.hdr{padding:2px 20px 0;font-size:11.5px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em}
.hdr span:last-child{text-align:right}
.row{background:#fff;border-radius:var(--r);box-shadow:var(--shadow);padding:15px 20px}
.row .who{font-weight:600;line-height:1.3}
.copy{cursor:pointer;border-bottom:1px dashed #1C2F5440}
.copy:hover{color:var(--blue);border-bottom-color:var(--blue)}
.sub{color:var(--ink-3);font-size:12.5px;margin-top:2px}
.cell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.right{display:flex;align-items:center;gap:9px;justify-content:flex-end;white-space:nowrap}
.st{display:inline-flex;align-items:center;gap:7px;border-radius:var(--pill);padding:6px 13px;font-size:13px;white-space:nowrap}
.st:before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.st.ok{background:var(--greenBg);color:var(--greenInk)}
.st.warn{background:var(--amberBg);color:var(--amberInk)}
.st.err{background:var(--redBg);color:var(--redInk)}
.st.skip{background:var(--line);color:var(--ink-2)}
.rows{display:grid;gap:10px}
.empty{background:#fff;border-radius:var(--r);box-shadow:var(--shadow);padding:30px 20px;text-align:center;color:var(--ink-3)}

/* ---------- настройки ---------- */
.cfg{display:grid;gap:16px}
.cfg h3{margin:0 0 10px;font-size:14px;letter-spacing:-.01em}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.grid label{display:block;font-size:11.5px;color:var(--ink-3);margin-bottom:5px}
.grid input{width:100%;min-width:0}
.chk{display:flex;gap:9px;align-items:center;font-size:14px;color:var(--ink-2);cursor:pointer}
.chk input{min-width:0;width:17px;height:17px;accent-color:var(--blue);padding:0}
.stats{display:flex;gap:26px;flex-wrap:wrap}
.stat .n{font-size:24px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
.stat .l{font-size:12px;color:var(--ink-3)}
.stat.ok .n{color:var(--green)}
.stat.err .n{color:var(--red)}
.path{font-size:12.5px;color:var(--ink-3);margin-top:8px;word-break:break-all}

/* ---------- подвал и мелочи ---------- */
.foot{color:var(--ink-3);font-size:12px;padding:0 20px}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--navy);color:#fff;
  border-radius:var(--pill);padding:11px 22px;font-size:14px;box-shadow:0 12px 30px -10px #16305a99;z-index:2147483647}
textarea{width:100%;height:210px;margin-top:10px;font:12px/1.45 ui-monospace,Consolas,monospace;
  border:1px solid var(--cello25);border-radius:14px;padding:10px;background:#fff;color:var(--ink)}
@media (max-width:1000px){
  .hdr{display:none}
  .row{grid-template-columns:1fr;gap:8px}
  .right{justify-content:flex-start;flex-wrap:wrap}
}
`;

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_CLASS = { saved: 'ok', no_fio: 'warn', duplicate: 'skip', error: 'err' };

/** «Щенников Алексей Дмитриевич» → «Щенников А. Д.»: место в строке дорого. */
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

export const UI = {
  root: null,
  mode: 'page',
  min: false,
  cfgOpen: false,
  filters: { q: '', date: '', status: '', manager: '' },

  mount(mode, host) {
    this.mode = mode || 'page';
    this.root = document.createElement('div');
    this.root.id = 'nsis-auto-panel';
    const shadow = this.root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    shadow.append(style, wrap);
    this.shadow = shadow;
    this.wrap = wrap;
    (host || document.body).appendChild(this.root);

    wrap.addEventListener('click', (e) => this.onClick(e));
    wrap.addEventListener('input', (e) => this.onInput(e));
    wrap.addEventListener('change', (e) => this.onChange(e));

    Core.on(() => this.render());
    this.render();
  },

  /** Короткое подтверждение действия — копирование иначе происходит молча. */
  toast(text) {
    const old = this.shadow.querySelector('.toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    this.shadow.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  },

  async copy(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.toast('Скопировано');
    } catch {
      this.toast(text);
    }
  },

  onClick(e) {
    const btn = e.target.closest('[data-do]');
    if (!btn) return;
    const { do: action, id } = btn.dataset;
    const entry = () => Core.state.entries.find((x) => x.requestId === id);
    const run = {
      check: () => Core.tick(),
      auto: () => (Core.state.auto ? Core.stopAuto() : Core.startAuto()),
      folder: () => (Core.state.folder === 'denied' ? Core.grant('folder') : Core.pick('folder')),
      inbox: () => (Core.state.inbox === 'denied' ? Core.grant('inbox') : Core.pick('inbox')),
      cfg: () => {
        this.cfgOpen = !this.cfgOpen;
        this.render();
      },
      min: () => {
        this.min = !this.min;
        this.render();
      },
      close: () => this.root.remove(),
      list: () => Core.openList(),
      paste: () => Core.pasteList(),
      diag: () => this.showDiag(),
      again: () => Core.again(id),
      open: () => Core.openFile(entry()),
      filePath: () => this.copy(Core.fullPath(entry())),
      copyFio: () => this.copy(((entry() || {}).fio || []).join(', ')),
      copyCase: () => this.copy((entry() || {}).caseNo || ''),
      dayPath: () => this.copy(Core.folderPath((entry() || {}).day)),
      rootPath: () => this.copy(Core.folderPath()),
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
    const { filter, cfg, cfgText } = e.target.dataset;
    if (filter) {
      this.filters[filter] = e.target.value;
      this.renderRows();
    }
    if (cfgText) Core.saveSettings({ [cfgText]: e.target.value.trim() });
    if (cfg) {
      Core.saveSettings({ [cfg]: e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value) });
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
        ? { text: 'сессия истекла', dot: 'warn' }
        : s.nsis === 'down'
        ? { text: 'НСИС недоступна', dot: 'down' }
        : { text: 'проверяем…', dot: 'off' };
    }
    if (s.inbox !== 'ready') return { text: 'папка загрузок не указана', dot: 'warn' };
    return s.auto ? { text: 'следим за папкой загрузок', dot: '' } : { text: 'слежение остановлено', dot: 'off' };
  },

  render() {
    const s = Core.state;
    const st = this.statusLine(s);
    const panel = this.mode === 'panel';

    this.wrap.className = `wrap${panel ? ' isPanel' : ''}${this.min ? ' isMin' : ''}`;
    this.wrap.innerHTML = `
      <div class="card flat top">
        <span class="sign"></span>
        <span class="ttl">Ответы НСИС</span>
        <span class="state"><span class="dot ${st.dot}"></span>${esc(st.text)}${
          s.manager ? ' · <b>' + esc(shortFio(s.manager)) + '</b>' : ''
        }${s.lastCheck ? ' · проверка ' + esc(new Date(s.lastCheck).toLocaleTimeString('ru-RU').slice(0, 5)) : ''}</span>
        ${
          panel
            ? `<button class="btn sec sm" data-do="min">${this.min ? 'Развернуть' : 'Свернуть'}</button>
               <button class="btn sec sm" data-do="close">×</button>`
            : ''
        }
      </div>
      ${this.min ? '' : this.bodyHtml(s)}
    `;
    if (!this.min) this.renderRows();
  },

  bodyHtml(s) {
    const panel = this.mode === 'panel';
    const managers = [...new Set(Core.state.entries.map((e) => e.manager).filter(Boolean))];
    return `
      ${this.notesHtml(s)}
      <div class="card flat acts">
        <button class="btn" data-do="check" ${s.busy ? 'disabled' : ''}>${
          s.busy ? 'Проверяем…' : panel ? 'Проверить сейчас' : 'Проверить папку'
        }</button>
        <button class="btn sec" data-do="cfg">${this.cfgOpen ? 'Скрыть настройки' : 'Настройки'}</button>
      </div>
      ${this.cfgOpen ? this.cfgHtml(s, panel) : ''}
      <div class="filters">
        <input class="q" data-filter="q" placeholder="Поиск по ФИО, делу или имени файла" value="${esc(this.filters.q)}">
        <input data-filter="date" placeholder="день: ${folderForDay(new Date())}" value="${esc(this.filters.date)}" style="max-width:160px">
        <select data-filter="status">
          <option value="">все статусы</option>
          ${Object.entries(STATUS)
            .map(([k, v]) => `<option value="${k}" ${this.filters.status === k ? 'selected' : ''}>${esc(v)}</option>`)
            .join('')}
        </select>
        ${
          managers.length > 1
            ? `<select data-filter="manager"><option value="">все ФУ</option>${managers
                .map((m) => `<option ${this.filters.manager === m ? 'selected' : ''}>${esc(m)}</option>`)
                .join('')}</select>`
            : ''
        }
      </div>
      <div class="hdr"><span>Должник</span><span>Дело</span><span>Ответ</span><span>Файл</span><span></span></div>
      <div id="rows" class="rows"></div>
      <div class="foot">Журнал — файлом <b>журнал.json</b> в папке с делами. Локальный инструмент, не сайт НСИС.</div>
    `;
  },

  /*
   * Примечание — это то, что мешает работе прямо сейчас: одна строка и
   * кнопка. Объяснения, почему браузер устроен так, а не иначе, живут в
   * справке, а не на рабочем экране.
   */
  notesHtml(s) {
    const notes = [];
    const note = (cls, title, body, button) =>
      notes.push(
        `<div class="note ${cls}"><b>${title}</b><div>${body}</div>${
          button ? `<div class="acts" style="margin-top:10px">${button}</div>` : ''
        }</div>`
      );

    if (s.folder === 'unsupported') {
      note('attn', 'Папки недоступны', 'Файлы сохраняются в «Загрузки» — с правильными именами, но без раскладки по дням.');
    } else {
      const needInbox = this.mode === 'page' && s.inbox === 'none';
      if (s.folder === 'none' && needInbox) {
        note(
          'attn',
          'Укажите две папки',
          'Куда складывать ответы и откуда их забирать.',
          '<button class="btn" data-do="folder">Папка НСИС</button><button class="btn sec" data-do="inbox">Папка загрузок</button>'
        );
      } else if (s.folder === 'none') {
        note('attn', 'Папка НСИС не выбрана', 'Пока файлы падают в «Загрузки» без раскладки по дням.', '<button class="btn" data-do="folder">Выбрать</button>');
      } else if (needInbox) {
        note('attn', 'Папка загрузок не выбрана', 'Укажите её — и ответы будут разбираться сами.', '<button class="btn" data-do="inbox">Выбрать</button>');
      }
      for (const [which, label] of [['folder', 'папке НСИС'], ['inbox', 'папке загрузок']]) {
        if (s[which] === 'denied') {
          note('attn', `Подтвердите доступ к ${label}`, 'Раз за сеанс браузера.', `<button class="btn" data-do="${which}">Подтвердить</button>`);
        }
      }
    }
    if (s.nsis === 'session') {
      note('attn', 'Сессия НСИС истекла', 'Войдите по УКЭП — работа продолжится сама.');
    }
    if (s.lastError && s.nsis !== 'session' && s.nsis !== 'blocked') {
      note('bad', s.lastError, 'Проверка повторится автоматически.');
    }
    return notes.join('');
  },

  cfgHtml(s, panel) {
    const c = Core.settings;
    const n = Core.counters();
    return `
      <div class="card cfg">
        <div>
          <h3>Сводка</h3>
          <div class="stats">
            <div class="stat ok"><div class="n">${n.saved}</div><div class="l">разложено сегодня</div></div>
            <div class="stat err"><div class="n">${n.errors}</div><div class="l">ошибок</div></div>
            <div class="stat"><div class="n">${n.skipped}</div><div class="l">пропущено</div></div>
            <div class="stat"><div class="n">${Core.state.entries.length}</div><div class="l">всего в журнале</div></div>
          </div>
        </div>
        <div>
          <h3>Папки</h3>
          <div class="acts">
            <button class="btn sec" data-do="folder">${s.folder === 'ready' ? 'Сменить папку НСИС' : 'Выбрать папку НСИС'}</button>
            ${panel ? '' : `<button class="btn sec" data-do="inbox">${s.inbox === 'ready' ? 'Сменить папку загрузок' : 'Выбрать папку загрузок'}</button>`}
            <button class="btn sec" data-do="rootPath">Скопировать путь к папке НСИС</button>
          </div>
          <div class="grid" style="margin-top:12px">
            <div style="grid-column:1/-1">
              <label>Полный путь к папке НСИС — для кнопок «Путь» и «Папка»</label>
              <input type="text" data-cfg-text="rootPath" placeholder="C:\\Users\\Имя\\Desktop\\НСИС" value="${esc(c.rootPath || '')}">
            </div>
          </div>
        </div>
        <div>
          <h3>Проверка</h3>
          <div class="acts" style="margin-bottom:12px">
            <button class="btn sec" data-do="auto">${
              s.auto ? (panel ? 'Остановить автопроверку' : 'Остановить слежение') : panel ? 'Включить автопроверку' : 'Включить слежение'
            }</button>
          </div>
          <div class="grid">
            ${
              panel
                ? `<div><label>Интервал автопроверки, мин</label><input type="number" min="1" max="600" data-cfg="intervalMin" value="${c.intervalMin}"></div>
                   <div><label>Параллельных загрузок</label><input type="number" min="1" max="8" data-cfg="concurrency" value="${c.concurrency}"></div>
                   <div><label>Страниц журнала за проверку</label><input type="number" min="1" max="20" data-cfg="deepPages" value="${c.deepPages}"></div>`
                : `<div><label>Проверять папку раз в, секунд</label><input type="number" min="3" max="600" data-cfg="watchSec" value="${c.watchSec}"></div>`
            }
            <div><label>Повторов при ошибке</label><input type="number" min="1" max="10" data-cfg="retries" value="${c.retries}"></div>
          </div>
          <div class="acts" style="margin-top:12px">
            <label class="chk"><input type="checkbox" data-cfg="withCase" ${c.withCase ? 'checked' : ''}> номер дела в имени файла</label>
            ${panel ? '' : `<label class="chk"><input type="checkbox" data-cfg="moveFromInbox" ${c.moveFromInbox ? 'checked' : ''}> убирать разложенное из папки загрузок</label>`}
          </div>
        </div>
        ${this.mode === 'page' ? this.bridgeHtml(s) : ''}
        <div>
          <h3>Диагностика</h3>
          <div class="acts"><button class="btn sec" data-do="diag">Собрать отчёт о состоянии</button></div>
          <div id="diag"></div>
        </div>
      </div>
    `;
  },

  /* Мост лежит в настройках: нужен редко, на главном экране только мешал. */
  bridgeHtml(s) {
    const b = s.bridge;
    const result = !b
      ? ''
      : b.error
      ? `<div class="sub" style="color:var(--redInk);margin-top:8px">${esc(b.error)}</div>`
      : `<div class="sub" style="margin-top:8px">Обращений в списке: ${b.seen}, с готовым ответом: ${b.ready}. Запущено скачиваний: ${b.started}.</div>`;
    return `
      <div>
        <h3>Список обращений НСИС</h3>
        <div class="sub">Сохраните открывшуюся вкладку (Ctrl+S) в папку загрузок или скопируйте и вставьте.</div>
        <div class="acts" style="margin-top:10px">
          <button class="btn sec" data-do="list">Открыть список</button>
          <button class="btn sec" data-do="paste">Вставить список</button>
        </div>${result}
      </div>`;
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
    host.innerHTML = rows.map((e) => this.rowHtml(e)).join('');
  },

  rowHtml(e) {
    // У ошибки ФИО ещё неизвестно — «Не определено» только там, где файл
    // сохранён, а разбор не дал результата.
    const fio = (e.fio || []).join(', ') || (e.status === 'error' ? '—' : 'Не определено');
    const birth = e.birth && Object.values(e.birth)[0] ? Object.values(e.birth)[0] : '';
    const inFolder = e.place === 'folder' && e.fileName;
    const sub = [birth ? `${birth} г. р.` : '', shortFio(e.manager)].filter(Boolean).join(' · ');
    return `
      <div class="row">
        <div><div class="who"><span class="copy" data-do="copyFio" data-id="${esc(e.requestId)}" title="Нажмите, чтобы скопировать ФИО">${esc(fio)}</span></div>${
          sub ? `<div class="sub cell">${esc(sub)}</div>` : ''
        }</div>
        <div class="cell">${
          e.caseNo
            ? `<span class="copy" data-do="copyCase" data-id="${esc(e.requestId)}" title="Нажмите, чтобы скопировать номер дела">${esc(e.caseNo)}</span>`
            : '—'
        }</div>
        <div class="cell">${esc(e.answerDate || dateOf(e.createDate) || '—')}</div>
        <div>${
          e.fileName
            ? `<div class="cell" title="${esc(e.fileName)}">${esc(e.fileName)}</div><div class="sub cell" title="${esc(Core.fullPath(e))}">${esc(Core.fullPath(e))}</div>`
            : `<div class="sub">${esc(e.error || '—')}</div>`
        }</div>
        <div class="right">
          <span class="st ${STATUS_CLASS[e.status] || ''}">${esc(STATUS[e.status] || e.status)}</span>
          ${inFolder && Core.state.folder === 'ready' ? `<button class="btn sec sm" data-do="open" data-id="${esc(e.requestId)}">Открыть</button>` : ''}
          ${e.fileName ? `<button class="btn sec sm" data-do="filePath" data-id="${esc(e.requestId)}" title="Скопировать полный путь к файлу">Путь</button>` : ''}
          ${inFolder ? `<button class="btn sec sm" data-do="dayPath" data-id="${esc(e.requestId)}" title="Скопировать путь к папке с этим файлом">Папка</button>` : ''}
          ${e.status === 'error' ? `<button class="btn sec sm" data-do="again" data-id="${esc(e.requestId)}" title="Попробовать скачать ещё раз">Повторить</button>` : ''}
        </div>
        ${e.error && e.fileName ? `<div class="sub" style="grid-column:1/-1">${esc(e.error)}${e.attempts ? `, попыток: ${e.attempts}` : ''}</div>` : ''}
      </div>`;
  },

  /*
   * Отчёт показываем прямо в настройках и кладём в буфер: на рабочем
   * компьютере консоль открывать неудобно, а переслать текст — просто.
   */
  async showDiag() {
    const host = this.wrap.querySelector('#diag');
    if (host) host.innerHTML = '<div class="sub" style="margin-top:10px">Собираем отчёт…</div>';
    let text;
    try {
      text = await report();
    } catch (e) {
      text = 'Диагностика не собралась: ' + ((e && e.message) || e);
    }
    let copied = '';
    try {
      await navigator.clipboard.writeText(text);
      copied = ' Он уже в буфере обмена.';
    } catch {
      copied = ' Выделите текст и скопируйте вручную.';
    }
    const box = this.wrap.querySelector('#diag');
    if (box) {
      box.innerHTML = `<div class="sub" style="margin-top:10px">Личных данных в отчёте нет.${copied}</div><textarea readonly></textarea>`;
      box.querySelector('textarea').value = text;
    }
  },
};
