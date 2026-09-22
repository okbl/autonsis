/*
 * Сборка. Внешних зависимостей нет: модули из src/ склеиваются в один
 * IIFE — без сборщика, без npm install.
 *
 *   node build.mjs
 *
 * На выходе:
 *   dist/nsis.js                     — код для сниппета DevTools (с комментариями);
 *   dist/НСИС — установка.html       — страница с закладкой и инструкцией.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ORDER = ['pdftext.js', 'parse.js', 'name.js', 'api.js', 'store.js', 'core.js', 'ui.js', 'boot.js'];

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
<title>НСИС — автоскачивание ответов: установка</title>
<style>
:root{
  --bg:#F1ECE6;--surface:#FBF9F6;--surface-2:#E7E0D8;--line:#DDD5CD;--line-2:#C6BCB1;
  --ink:#2B2D31;--ink-2:#5F6165;--ink-3:#8A867F;--acc:#8D321F;--acc-2:#A94229;--acc-wash:#F6E7E2;
  --r:16px;--r-sm:10px;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:Onest,"Segoe UI",system-ui,sans-serif;font-size:16px;line-height:1.5;
  font-variant-numeric:tabular-nums}
.page{max-width:820px;margin:0 auto;padding:36px 22px 60px}
h1{font-size:30px;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:19px;letter-spacing:-.015em;margin:34px 0 10px}
p,li{color:var(--ink-2)}
b,strong{color:var(--ink)}
code{background:var(--surface-2);border-radius:5px;padding:1px 5px;font-size:14px}
.lead{font-size:17px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;margin:16px 0}
.bmk{display:inline-block;background:var(--acc);color:#FBF9F6;text-decoration:none;font-weight:600;
  border-radius:999px;padding:10px 20px;cursor:grab}
.bmk:hover{background:var(--acc-2)}
.btn{border:1px solid var(--line-2);background:var(--surface);color:var(--ink-2);border-radius:999px;
  padding:8px 16px;font:inherit;font-size:14px;cursor:pointer}
.btn:hover{border-color:var(--ink-3);color:var(--ink)}
ol{padding-left:22px}
ol li{margin:6px 0}
.note{background:var(--acc-wash);border:1px solid #E2C6BC;border-radius:var(--r-sm);padding:12px 14px;font-size:15px}
.mark{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#8D321F,#7D4047);display:inline-block;vertical-align:-5px;margin-right:9px}
pre{display:none}
</style>
</head>
<body>
<div class="page">
<h1><span class="mark"></span>НСИС — автоскачивание ответов</h1>
<p class="lead">Приложение работает на странице личного кабинета НСИС: находит готовые
ответы, скачивает PDF, читает из них ФИО должника, дату рождения и номер дела,
раскладывает файлы по папкам за день и ведёт журнал. Ничего не устанавливается,
данные остаются на этом компьютере.</p>

<h2>Установка: способ 1 — закладка</h2>
<div class="card">
  <p>Включите панель закладок (<code>Ctrl+Shift+B</code>) и перетащите на неё эту кнопку:</p>
  <p><a class="bmk" href="${bookmarklet.replace(/"/g, '&quot;')}">НСИС — забрать ответы</a></p>
  <p>Дальше: откройте <code>lk.nsis.ru/requestLog</code>, войдите по УКЭП и нажмите закладку.</p>
</div>

<h2>Способ 2 — сниппет DevTools</h2>
<div class="card">
  <p>Годится, если закладка не сработала (сайт может запрещать такие закладки политикой безопасности).</p>
  <ol>
    <li>Нажмите кнопку ниже — код скопируется в буфер обмена.</li>
    <li>На странице НСИС откройте <code>F12</code> → <b>Sources</b> → <b>Snippets</b> → <b>New snippet</b>.</li>
    <li>Вставьте код, назовите сниппет «НСИС» и сохраните (<code>Ctrl+S</code>).</li>
    <li>Запуск — <code>Ctrl+Enter</code>. Сниппет сохраняется, вставлять заново не нужно.</li>
  </ol>
  <p><button class="btn" id="copy">Скопировать код</button> <span id="done"></span></p>
  <pre id="code"></pre>
</div>

<h2>Как этим пользоваться</h2>
<ol>
  <li>Вошли в НСИС по УКЭП, открыли «Обращения», запустили панель.</li>
  <li>Один раз нажали «Выбрать папку» и указали, например, «Рабочий стол\\НСИС».
      Внутри появятся папки по дням: <code>20.09.2026</code>.</li>
  <li>Дальше можно просто работать. Пока вкладка открыта, панель сама проверяет НСИС
      каждые 15 минут (интервал меняется в настройках) и забирает новые готовые ответы.
      Кнопка «Проверить сейчас» — если ждать не хочется.</li>
</ol>

<h2>Что получается на диске</h2>
<p><code>Рабочий стол\\НСИС\\20.09.2026\\Борцов Николай Валерьевич — А50-26151-2025 — 20.09.2026 14-35-12.pdf</code></p>
<p>Если ФИО в ответе определить не удалось, файл всё равно сохраняется — как
<code>Не определено — …</code>, и в журнале это видно отдельным статусом. Рядом с папками
приложение держит копию журнала <code>журнал.json</code>: браузерное хранилище можно
случайно очистить, а папку с делами — нет.</p>

<h2>Если что-то не работает</h2>
<div class="note">
  <p><b>Закладка не запускается.</b> Это защита сайта, а не поломка. Пользуйтесь сниппетом.</p>
  <p><b>Панель пишет «Запись в папку недоступна».</b> Политика запрещает странице писать на диск.
  Файлы будут сохраняться в «Загрузки» — с правильными именами, но без раскладки по дням.</p>
  <p><b>Панель пишет «Сессия истекла».</b> Войдите в НСИС заново в этой вкладке; приложение
  само заметит новую сессию, определит ФУ и продолжит.</p>
  <p><b>«Ошибка скачивания» на всех ответах.</b> Возможно, НСИС требует подпись УКЭП на скачивание.
  Напишите об этом — тогда скачивание придётся делать нажатием кнопки в интерфейсе.</p>
</div>

<h2>Что приложение не делает</h2>
<p>Не создаёт запросы в НСИС, не ходит в 1С, не отправляет ничего в интернет, не трогает
УКЭП, сертификаты и пароли, не удаляет файлы. Автопроверка работает только пока открыта
вкладка НСИС — программ на компьютере не появляется.</p>
</div>
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
</script>
</body>
</html>
`;

// index.html — для хостинга (Pages раздаёт его как корень сайта).
// Второй файл с человеческим именем — чтобы открывать двойным кликом локально.
for (const name of ['index.html', 'НСИС — установка.html']) {
  fs.writeFileSync(path.join(root, 'dist', name), page);
}

const kb = (s) => (s.length / 1024).toFixed(1) + ' КБ';
console.log(`dist/nsis.js                 ${kb(bundle)}`);
console.log(`dist/index.html               ${kb(page)}`);
console.log(`закладка (javascript:)       ${kb(bookmarklet)}`);
