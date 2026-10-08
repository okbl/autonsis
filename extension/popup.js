/* Маленькое окно: состояние, ручная проверка и переход к раскладке. */
const APP = 'https://okbl.github.io/autonsis/';

const TEXT = {
  ok: ['в порядке', 'ok'],
  session: ['войдите в НСИС по УКЭП', 'warn'],
  offline: ['НСИС недоступен', 'err'],
  error: ['ошибка', 'err'],
};

function show(state) {
  const [label, cls] = TEXT[state.status] || ['проверяем…', ''];
  const el = document.getElementById('status');
  el.textContent = state.error ? `${label} (${state.error})` : label;
  el.className = 'st ' + cls;
  document.getElementById('when').textContent = state.checkedAt
    ? new Date(state.checkedAt).toLocaleTimeString('ru-RU')
    : '—';
  document.getElementById('last').textContent = state.lastSaved ?? '—';
  document.getElementById('total').textContent = state.saved ?? '—';
  document.getElementById('left').textContent = state.left ? String(state.left) : '—';
}

/* ---------------- настройки ---------------- */

const FIELDS = ['batch', 'parallel', 'intervalMin', 'logLimit'];

function fill(settings) {
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (settings && settings[key] !== undefined) el.value = settings[key];
  }
}

let timer = null;
function save() {
  const patch = {};
  for (const key of FIELDS) {
    const raw = document.getElementById(key).value;
    if (raw !== '') patch[key] = Number(raw);
  }
  clearTimeout(timer);
  // Небольшая пауза: пока человек набирает «20», не сохранять ещё и «2».
  timer = setTimeout(() => {
    chrome.runtime.sendMessage({ settings: patch }, (saved) => {
      fill(saved);
      const note = document.getElementById('saved');
      note.textContent = 'Сохранено';
      setTimeout(() => (note.textContent = ''), 1500);
    });
  }, 600);
}

for (const key of FIELDS) document.getElementById(key).addEventListener('input', save);

chrome.runtime.sendMessage('state', (res) => {
  show((res && res.state) || {});
  fill(res && res.settings);
});

document.getElementById('check').addEventListener('click', (e) => {
  e.target.textContent = 'Проверяем…';
  e.target.disabled = true;
  chrome.runtime.sendMessage('check', (state) => {
    show(state || {});
    e.target.textContent = 'Проверить сейчас';
    e.target.disabled = false;
  });
});

document.getElementById('open').addEventListener('click', () => chrome.tabs.create({ url: APP }));
