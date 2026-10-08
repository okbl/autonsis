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
import { minify } from 'terser';

const root = path.dirname(fileURLToPath(import.meta.url));
const ORDER = ['pdftext.js', 'parse.js', 'name.js', 'api.js', 'bridge.js', 'store.js', 'core.js', 'diag.js', 'ui.js', 'boot.js'];

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

/*
 * Для закладки размер решает всё: браузер вправе не принять слишком длинный
 * адрес. Поэтому её код сжимается, а читаемая версия остаётся в dist/nsis.js.
 */
async function bookmark(src) {
  const out = await minify(`(function(){'use strict';\n${strip(src)}\n})();`, {
    compress: { passes: 2 },
    mangle: true,
    format: { comments: false },
  });
  return 'javascript:' + encodeURIComponent(`void ${out.code}`);
}

const bookmarklet = await bookmark(body);
const grabSrc = flatten(fs.readFileSync(path.join(root, 'src', 'grab.js'), 'utf8'));
const grabmark = await bookmark(grabSrc);

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
  /* палитра кабинета НСИС: акцент, глубокий синий, фон, поверхности */
  --bg:#F2F5FA;--surface:#fff;--surface-2:#ECEEF2;--line:#ECEEF2;--line-2:#1C2F5440;
  --ink:#2F3541;--ink-2:#575D69;--ink-3:#7E8492;--acc:#0A4FCA;--acc-2:#003D99;--navy:#162F5A;
  --shadow:0 8px 16px -4px #2f35411a,0 4px 8px 0 #2f35410d;
  --r:26px;--r-sm:20px;
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);
  font-family:Onest,"Segoe UI",system-ui,sans-serif;font-size:15px;line-height:1.5;
  font-variant-numeric:tabular-nums}
.page{max-width:1160px;margin:0 auto;padding:22px 20px 56px}
h2{font-size:17px;letter-spacing:-.015em;margin:0}
p,li{color:var(--ink-2)}
b,strong{color:var(--ink)}
code{background:var(--surface-2);border-radius:5px;padding:1px 5px;font-size:13.5px}
.card{background:var(--surface);border-radius:var(--r);box-shadow:var(--shadow);padding:18px 20px;margin:14px 0}
details.card>summary{cursor:pointer;list-style:none;font-size:16px;font-weight:600;letter-spacing:-.015em;
  display:flex;align-items:center;gap:9px;color:var(--ink)}
details.card.small>summary{font-size:15px}
details.card>summary::-webkit-details-marker{display:none}
details.card .caret{width:7px;height:7px;border-right:2px solid var(--acc);border-bottom:2px solid var(--acc);
  transform:rotate(45deg);transition:transform .18s;margin-bottom:3px}
details.card[open] .caret{transform:rotate(-135deg);margin-bottom:-2px}
details.card>summary+*{margin-top:12px}
.bmk{display:inline-block;background:var(--acc);color:#fff;text-decoration:none;font-weight:600;
  border-radius:999px;padding:11px 22px;cursor:grab}
.bmk:hover{background:var(--acc-2)}
.btn{display:inline-block;border:1px solid var(--line-2);background:var(--surface);color:var(--ink);
  border-radius:999px;padding:10px 20px;font:inherit;font-size:14px;cursor:pointer;text-decoration:none}
.btn:hover{border-color:var(--acc);color:var(--acc)}
ol{padding-left:22px}
ol li{margin:6px 0}
.small{font-size:13.5px}
.drop{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(16px);opacity:0;
  pointer-events:none;transition:opacity .15s,transform .15s;
  background:var(--acc);color:#fff;border-radius:999px;padding:12px 26px;font-size:14px;font-weight:600;
  box-shadow:0 14px 30px -12px #0a4fca99}
body.isDrag .drop{opacity:1;transform:translateX(-50%)}
pre{display:none}
.foot{color:var(--ink-3);font-size:12.5px;margin-top:22px}
</style>
</head>
<body>
<div class="page">
  <div id="nsis-app"></div>

  <div class="drop">Отпустите — разберём и разложим</div>

  <details class="card">
    <summary><span class="caret"></span>Забирать ответы без кнопки «Скачать»</summary>
    <p>Закладка работает на странице кабинета: находит готовые ответы, скачивает их в папку
    загрузок, остальное делает эта страница. Политика браузера может её не пустить — тогда
    способ не сработает, и ответы скачиваются в кабинете как обычно.</p>
    <p><a class="bmk" href="${grabmark.replace(/"/g, '&quot;')}">Забрать ответы НСИС</a>
       <span class="small">&nbsp;перетащите на панель закладок, ${(grabmark.length / 1024).toFixed(1)} КБ</span></p>
    <p class="small">Тяжёлый вариант — та же панель прямо в кабинете, с автопроверкой:
       <a class="bmk" href="${bookmarklet.replace(/"/g, '&quot;')}">Панель в кабинете</a>
       &nbsp;${(bookmarklet.length / 1024).toFixed(0)} КБ. Тот же код сниппетом DevTools:
       <button class="btn" id="copy">Скопировать код</button> <span id="done"></span></p>
    <pre id="code"></pre>
  </details>

  <details class="card">
    <summary><span class="caret"></span>Совсем без нажатий — расширение</summary>
    <p>Проверяет НСИС само, раз в 15 минут, и складывает ответы в <code>Загрузки\nsis-inbox</code>.
    Ставится администратором политикой браузера; программ на компьютере не появляется.</p>
    <p><a class="btn" href="nsis-extension.zip" download>Скачать расширение (.zip)</a></p>
    <p class="small">Установка и готовый текст заявки в ИТ — в <code>docs/EXTENSION.md</code>.</p>
  </details>

  <details class="card small">
    <summary><span class="caret"></span>Как это работает</summary>
    <p>Скачивайте ответы в кабинете как обычно — приложение заберёт их из папки загрузок,
    прочитает из PDF ФИО должника, дату рождения и номер дела, назовёт файл по-человечески
    и разложит по папкам за день.</p>
    <p>Ответы, журнал и настройки остаются на компьютере. Единственный сетевой запрос
    приложение делает к самому НСИС и только со страницы кабинета — туда же, куда ходит
    сам кабинет. Эта страница ничего не загружает со стороны и ничего не отправляет:
    можно сохранить её на диск или флешку и работать без интернета.</p>
    <p>Приложение не создаёт запросы в НСИС, не ходит в 1С, не трогает УКЭП, сертификаты
    и пароли и ничего не удаляет само — кроме файлов, которые убирает из папки загрузок
    после раскладки, и это отключается в настройках.</p>
  </details>

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

// Макеты интерфейса и схемы — статичные файлы, логики в них нет; кладём рядом,
// чтобы их можно было открыть по адресу с рабочего компьютера.
const designDir = path.join(root, 'design');
if (fs.existsSync(designDir)) {
  const flat = fs.readdirSync(designDir).filter((n) => /\.(html|svg|pdf)$/.test(n));
  for (const name of flat) {
    fs.copyFileSync(path.join(designDir, name), path.join(root, 'dist', name));
    console.log(`dist/${name}`.padEnd(29) + kb({ length: fs.statSync(path.join(designDir, name)).size }));
  }
  // Латинские имена рядом с русскими: такой адрес проще передать и набрать.
  for (const [from, to] of [['обмен.svg', 'scheme.svg'], ['НСИС — автозапросы.pdf', 'nsis-auto.pdf']]) {
    if (flat.includes(from)) fs.copyFileSync(path.join(designDir, from), path.join(root, 'dist', to));
  }
}

console.log(`dist/nsis.js                 ${kb(bundle)}`);
console.log(`dist/index.html               ${kb(page)}`);
console.log(`закладка «забрать»           ${kb(grabmark)}`);
console.log(`закладка «панель»            ${kb(bookmarklet)}`);
