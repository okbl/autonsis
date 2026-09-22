/*
 * Диагностика: одна кнопка — и приложение рассказывает, что у него не вышло.
 *
 * «Не работает» без подробностей стоит нескольких писем туда-обратно, а по
 * рабочему компьютеру отладчиком не походишь. Поэтому отчёт собирается прямо
 * на месте: состояние, ответы кабинета и — главное — форма данных, которые он
 * вернул. Именно по ней видно, совпадают ли наши ожидания с действительностью.
 *
 * Персональные данные в отчёт не попадают: строки с русскими буквами, почтой и
 * длинными числами заменяются на пометку о длине, остаются только служебные
 * значения вроде "done" и размеров файлов.
 */

import { Nsis, answerOf, statusCodeOf } from './api.js';
import { Core, HUMAN } from './core.js';
import { Store } from './store.js';

const SAFE = /^[A-Za-z0-9_.:+-]{1,48}$/;

/** Скелет значения: ключи и типы — без личных данных. */
export function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[${shape(value[0], depth + 1)}${value.length > 1 ? `, …ещё ${value.length - 1}` : ''}]`;
  }
  switch (typeof value) {
    case 'object': {
      if (depth > 3) return '{…}';
      const parts = Object.keys(value)
        .slice(0, 24)
        .map((k) => `${k}: ${shape(value[k], depth + 1)}`);
      return `{ ${parts.join(', ')} }`;
    }
    case 'string':
      if (!value) return '""';
      return SAFE.test(value) ? JSON.stringify(value) : `"<строка, ${value.length} симв.>"`;
    case 'number':
    case 'boolean':
      return String(value);
    default:
      return typeof value;
  }
}

async function probe(title, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    return { title, ok: true, ms: Date.now() - started, value };
  } catch (e) {
    return {
      title,
      ok: false,
      ms: Date.now() - started,
      code: e && e.code,
      status: e && e.status,
      text: String((e && e.message) || e),
    };
  }
}

export async function report() {
  const s = Core.state;
  const lines = [];
  const add = (...parts) => lines.push(parts.join(''));

  add('НСИС — диагностика ', new Date().toLocaleString('ru-RU'));
  add('адрес: ', location.origin + location.pathname);
  add('режим: ', s.mode === 'panel' ? 'панель на странице кабинета' : 'страница-приложение');
  add('браузер: ', (navigator.userAgent.match(/(Chrome|Chromium|Firefox|Safari)\/[\d.]+/g) || []).join(' '));
  add('доступ к папкам (File System Access): ', typeof window.showDirectoryPicker === 'function' ? 'есть' : 'нет');
  add('папка НСИС: ', s.folder, ', папка загрузок: ', s.inbox);
  add('слежение: ', s.auto ? 'включено' : 'выключено', ', занят: ', String(s.busy));
  add('состояние НСИС: ', s.nsis, s.lastError ? ` (${s.lastError})` : '');
  add('ФУ: ', s.manager ? 'определён' : 'не определён');

  const entries = await Store.all().catch(() => []);
  const byStatus = {};
  for (const e of entries) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
  add('записей в журнале: ', String(entries.length), ' ', JSON.stringify(byStatus));

  const lastErrors = entries.filter((e) => e.status === 'error').slice(0, 3);
  if (lastErrors.length) {
    add('');
    add('--- последние ошибки ---');
    for (const e of lastErrors) {
      add('обращение ', String(e.requestId).slice(0, 12), '…: ', e.error || '', ' (код ', e.errorCode || '—', ', попыток ', String(e.attempts || 0), ')');
    }
  }

  add('');
  add('--- профиль кабинета ---');
  const profile = await probe('profile', () => Nsis.profile());
  if (profile.ok) {
    add('GET bff/profile → ответ получен за ', String(profile.ms), ' мс');
    add('форма: ', shape(profile.value));
  } else {
    add('GET bff/profile → ошибка: ', profile.code || '—', ' ', profile.status || '', ' ', HUMAN[profile.code] || profile.text);
  }

  add('');
  add('--- журнал обращений ---');
  const log = await probe('log', () => Nsis.log({ limit: 3, offset: 0 }));
  if (log.ok) {
    const rows = (log.value && (log.value.queries || (log.value.data && log.value.data.queries))) || [];
    add('GET bff/bff-query-log/request-log?limit=3 → ответ получен за ', String(log.ms), ' мс');
    add('верхний уровень: ', shape(log.value, 2));
    add('записей: ', String(rows.length), ', из них с готовым PDF (как их видит приложение): ',
      String(rows.filter((q) => answerOf(q)).length));
    if (rows.length) {
      add('статусы: ', rows.map((q) => statusCodeOf(q) || '—').join(', '));
      add('форма первой записи:');
      add(shape(rows[0]));
    }
  } else {
    add('GET bff/bff-query-log/request-log → ошибка: ', log.code || '—', ' ', log.status || '', ' ', HUMAN[log.code] || log.text);
  }

  return lines.join('\n');
}
