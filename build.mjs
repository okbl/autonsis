/*
 * Сборка. Внешних зависимостей нет: модули из src/ склеиваются в один
 * IIFE — без сборщика, без npm install.
 *
 *   node build.mjs
 *
 * На выходе:
 *   dist/index.html   — само приложение: открыл адрес и работаешь;
 *   dist/nsis.js      — тот же код для сниппета DevTools (с комментариями);
 *   внутри страницы   — закладка для автозабора из НСИС.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ORDER = ['pdftext.js', 'parse.js', 'name.js', 'api.js', 'store.js', 'core.js', 'diag.js', 'ui.js', 'boot.js'];

/** Убираем import/export: в одном файле модули не нужны. */
function flatten(src) {
  return src
    .replace(/^\s*import\s[^;]*;\s*$/gm, '')
    .replace(/^export\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

/** Для закладки комментарии лишние — считается длина URL. */
function strip(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*');
    })
    .join('\n');
}

const parts = ORDER.map((f) => flatten(fs.readFileSync(path.join(root, 'src', f), 'utf8')));
const body = parts.join('\n');
const bundle = `(function(){'use strict';\n${body}\n})();\n`;
const lean = `(function(){'use strict';\n${strip(body)}\n})();`;
const bookmarklet = 'javascript:' + encodeURIComponent(`void ${lean}`);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'nsis.js'), bundle);

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>НСИС — ответы</title>
<style>
:root{
  --bg:#F1ECE6;--surface:#FBF9F6;--surface-2:#E7E0D8;--line:#DDD5CD;--line-2:#C6BCB1;
  --ink:#2B2D31;--ink-2:#5F6165;--ink-3:#8A867F;--acc:#8D321F;--acc-2:#A94229;--acc-wash:#F6E7E2;
  --r:16px;--r-sm:10px;
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);
  font-family:Onest,"Segoe UI",system-ui,sans-serif;font-size:15px;line-height:1.5;
  font-variant-numeric:tabular-nums}
.page{max-width:1080px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 6px;display:flex;align-items:center;gap:10px}
.mark{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#8D321F,#7D4047)}
.lead{color:var(--ink-2);margin:0 0 20px;max-width:70ch}
h2{font-size:17px;letter-spacing:-.015em;margin:0}
p,li{color:var(--ink-2)}
b,strong{color:var(--ink)}
code{background:var(--surface-2);border-radius:5px;padding:1px 5px;font-size:13.5px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;margin:16px 0}
details.card>summary{cursor:pointer;list-style:none;font-size:17px;font-weight:600;letter-spacing:-.015em;
  display:flex;align-items:center;gap:9px;color:var(--ink)}
details.card>summary::-webkit-details-marker{display:none}
details.card .caret{width:7px;height:7px;border-right:2px solid var(--ink-3);border-bottom:2px solid var(--ink-3);
  transform:rotate(45deg);transition:transform .18s;margin-bottom:3px}
details.card[open] .caret{transform:rotate(-135deg);margin-bottom:-2px}
details.card>summary+*{margin-top:12px}
.bmk{display:inline-block;background:var(--acc);color:#FBF9F6;text-decoration:none;font-weight:600;
  border-radius:999px;padding:10px 20px;cursor:grab}
.bmk:hover{background:var(--acc-2)}
.btn{border:1px solid var(--line-2);background:var(--surface);color:var(--ink-2);border-radius:999px;
  padding:8px 16px;font:inherit;font-size:14px;cursor:pointer}
.btn:hover{border-color:var(--ink-3);color:var(--ink)}
ol{padding-left:22px}
ol li{margin:6px 0}
.small{font-size:13.5px}
.drop{border:1.5px dashed var(--line-2);border-radius:var(--r);padding:14px 18px;margin:16px 0;
  color:var(--ink-3);font-size:13.5px;text-align:center}
body.isDrag .drop{border-color:var(--acc);color:var(--acc);background:var(--acc-wash)}
pre{display:none}
.foot{color:var(--ink-3);font-size:12.5px;margin-top:26px}
</style>
</head>
<body>
<div class="page">
  <h1><span class="mark"></span>НСИС — ответы</h1>
  <p class="lead">Скачивайте ответы в личном кабинете как обычно. Приложение заберёт их из папки
  загрузок, прочитает из PDF ФИО должника, дату рождения и номер дела, назовёт файл
  по-человечески и разложит по папкам за день. Всё происходит на этом компьютере:
  ни файлы, ни данные никуда не отправляются.</p>

  <div id="nsis-app"></div>

  <div class="drop">Можно просто перетащить PDF сюда — разберём и разложим</div>

  <details class="card">
    <summary><span class="caret"></span>Забирать из НСИС автоматически</summary>
    <p>Эта страница не может обращаться к НСИС: сессия кабинета принадлежит его адресу,
    и браузер не отдаёт её чужой странице. Но тот же код умеет работать прямо на странице
    кабинета — тогда нажимать «Скачать» не нужно вовсе: он сам находит готовые ответы,
    забирает их и раскладывает в ту же папку, в тот же журнал.</p>
    <p>Включите панель закладок (<code>Ctrl+Shift+B</code>) и перетащите на неё кнопку:</p>
    <p><a class="bmk" href="${bookmarklet.replace(/"/g, '&quot;')}">НСИС — забрать ответы</a></p>
    <p>Дальше откройте <code>lk.nsis.ru/requestLog</code>, войдите по УКЭП и нажмите закладку —
    поверх кабинета появится такая же панель.</p>
    <p class="small"><b>Если закладка не запускается</b> — сайт вправе такие закладки запрещать.
    Тогда тот же код можно положить сниппетом: <code>F12</code> → <b>Sources</b> → <b>Snippets</b> →
    <b>New snippet</b>, вставить, сохранить (<code>Ctrl+S</code>), запускать <code>Ctrl+Enter</code>.
    Сниппет сохраняется в браузере, вставлять заново не нужно.</p>
    <p><button class="btn" id="copy">Скопировать код для сниппета</button> <span id="done"></span></p>
    <pre id="code"></pre>
  </details>

  <div class="card small">
    <h2>Коротко о данных</h2>
    <p>Ответы, журнал и настройки остаются на компьютере. Единственный сетевой запрос
    приложение делает к самому НСИС и только со страницы кабинета — туда же, куда ходит
    сам кабинет. Эта страница ничего не загружает со стороны и ничего не отправляет:
    можно сохранить её на диск или флешку и работать без интернета.</p>
    <p>Приложение не создаёт запросы в НСИС, не ходит в 1С, не трогает УКЭП, сертификаты
    и пароли и ничего не удаляет само — кроме файлов, которые убирает из папки загрузок
    после раскладки, и это отключается в настройках.</p>
  </div>

  <p class="foot">Журнал лежит файлом <code>журнал.json</code> в папке с делами — благодаря этому
  страница и панель на сайте НСИС видят одни и те же записи.</p>
</div>
<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>
<script>
const code = document.getElementById('code');
code.textContent = ${JSON.stringify(bundle)};
document.getElementById('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(code.textContent);
    document.getElementById('done').textContent = 'скопировано';
  } catch (e) {
    code.style.display = 'block';
    document.getElementById('done').textContent = 'скопируйте вручную';
  }
});
for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, () => document.body.classList.add('isDrag'));
}
for (const type of ['dragleave', 'drop']) {
  document.addEventListener(type, () => document.body.classList.remove('isDrag'));
}
</script>
</body>
</html>
`;


// index.html — корень сайта; копия с человеческим именем — чтобы открывать
// двойным кликом с диска или флешки, там приложение работает так же.
for (const name of ['index.html', 'НСИС — ответы.html']) {
  fs.writeFileSync(path.join(root, 'dist', name), page);
}

const kb = (s) => (s.length / 1024).toFixed(1) + ' КБ';
console.log(`dist/nsis.js                 ${kb(bundle)}`);
console.log(`dist/index.html               ${kb(page)}`);
console.log(`закладка (javascript:)       ${kb(bookmarklet)}`);
