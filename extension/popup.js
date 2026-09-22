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
}

chrome.runtime.sendMessage('state', (res) => show((res && res.state) || {}));

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
