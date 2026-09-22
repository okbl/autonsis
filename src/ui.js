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

import { Core, STATUS } from './core.js';
import { report } from './diag.js';
import { folderForDay } from './name.js';

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

export const UI = {
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
          `<div class="note"><b>Откуда брать ответы — не указано</b>Нажмите «Папка загрузок» и укажите папку, куда браузер сохраняет файлы. Страница будет сама забирать оттуда новые PDF. Файлы можно и просто перетащить сюда.<br><button class="btn" data-do="inbox">Папка загрузок</button></div>`
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
