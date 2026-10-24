// ===== AXIOMA — наблюдатель снаружи =====
//
// Сайт axiomaschool.com и кабинет lk.axiomaschool.com живут на Amvera и
// следят друг за другом. Но если ляжет Amvera целиком, сообщить некому.
// Этот скрипт запускает GitHub раз в 5 минут (.github/workflows/watch.yml):
// две неудачи подряд — тревога в Telegram через бота службы, починили —
// «СНОВА РАБОТАЕТ» с временем простоя. Пока лежит — напоминание раз в час.
//
// Состояние между запусками — state.json (кэш GitHub Actions).
// Настройки — в закрытых секретах и переменных репозитория.

import fs from 'node:fs';

const STATE = process.env.WATCH_STATE || 'state.json';
const CONFIRM = 2;
const REMIND_MS = 60 * 60_000;
const token = String(process.env.ALERT_TELEGRAM_TOKEN || '').trim();
const chat = String(process.env.ALERT_TELEGRAM_CHAT || '').trim();

const TARGETS = [
  {
    key: 'site', name: 'Сайт', host: 'axiomaschool.com',
    probes: [{ url: 'https://axiomaschool.com/', html: 'Axioma' }],
    impact: 'Не открывается сайт школы: заявки, опросник, цены, страницы предметов.',
    steps: ['Amvera → приложение сайта (Axioma) → «Журнал»: последняя ошибка.', 'Процесс не поднимается — «Перезапустить».', 'Шла выкладка — «Журнал сборки»: чем кончилась.'],
  },
  {
    key: 'cabinet', name: 'Кабинет', host: 'lk.axiomaschool.com',
    probes: [{ url: 'https://lk.axiomaschool.com/health', health: true }, { url: 'https://lk.axiomaschool.com/', html: 'Axioma' }],
    impact: 'Не открывается личный кабинет: уроки, вход, домашка, доска.',
    steps: ['Amvera → приложение кабинета (Axioma Lk) → «Журнал»: последняя ошибка.', 'Процесс не поднимается — «Перезапустить».', '503 — смотреть проект базы данных в Amvera.', 'Шла выкладка — «Журнал сборки»: обычно кабинет поднимается за 5–8 минут.'],
  },
];

const clock = (ms) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(ms));
function duration(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч${min % 60 ? ` ${min % 60} мин` : ''}`;
}

/** Одна проба с причиной, понятной человеку. */
async function probeOnce(p) {
  try {
    const res = await fetch(p.url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'axioma-watch' } });
    const text = await res.text();
    if (p.health) {
      let body = {};
      try { body = JSON.parse(text); } catch {}
      if (res.ok && body.status === 'ok') return { ok: true };
      if (res.status === 503) return { ok: false, reason: 'кабинет жив, но не видит базу данных (503)' };
    } else if (res.ok && text.includes(p.html)) return { ok: true };
    if ([502, 503, 504].includes(res.status)) return { ok: false, reason: `${res.status}: Amvera не достучалась до приложения — оно упало, перезапускается или не собралось` };
    if (res.ok) return { ok: false, reason: `${p.url} открывается, но страница пустая или не та` };
    return { ok: false, reason: `${p.url} отвечает ${res.status}` };
  } catch (err) {
    const code = err?.cause?.code || err?.cause?.errors?.[0]?.code || err?.name;
    return { ok: false, reason: code === 'TimeoutError' ? `${p.url} не ответил за 15 с`
      : code === 'ENOTFOUND' ? 'адрес не находится (DNS)'
      : code === 'ECONNREFUSED' ? 'соединение отклонено'
      : /CERT|SSL|TLS/i.test(String(code)) ? `ошибка сертификата (${code})`
      : `нет связи (${code || err.message})` };
  }
}

/** Цель жива, если все её пробы прошли; неудачную пробу повторяем через 20 с. */
async function probe(t) {
  for (const p of t.probes) {
    let r = await probeOnce(p);
    if (!r.ok) { await new Promise((ok) => setTimeout(ok, Number(process.env.WATCH_RETRY_MS ?? 20_000))); r = await probeOnce(p); }
    if (!r.ok) return r;
  }
  return { ok: true };
}

async function telegram(method, body) {
  if (!token || !chat) { console.log(`[без бота] ${method}: ${body.text ?? ''}`); return null; }
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `Telegram ${res.status}`);
  return data.result;
}

async function say(text, { thread, replyTo } = {}) {
  const send = (t) => telegram('sendMessage', {
    chat_id: chat, text, parse_mode: 'HTML',
    ...(t ? { message_thread_id: t } : {}),
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  });
  try {
    return (await send(thread))?.message_id ?? null;
  } catch (err) {
    // Тема могла пропасть — тогда в общий чат, лишь бы дошло.
    if (thread) try { return (await send(null))?.message_id ?? null; } catch {}
    console.error('В Telegram не ушло:', err.message);
    return null;
  }
}

function load() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}

async function main() {
  const state = load();
  state.targets ??= {};
  const results = {};
  for (const t of TARGETS) results[t.key] = await probe(t);

  // Номера тем группы службы узнаём у кабинета, пока он жив.
  if (results.cabinet.ok) {
    try {
      const s = await (await fetch('https://lk.axiomaschool.com/api/public/status', { signal: AbortSignal.timeout(10_000) })).json();
      if (s.topics) state.topics = s.topics;
    } catch {}
  }
  const urgent = state.topics?.urgent;
  const allDown = TARGETS.every((t) => !results[t.key].ok);
  const now = Date.now();

  for (const t of TARGETS) {
    const r = results[t.key];
    const s = (state.targets[t.key] ??= { fails: 0 });
    const thread = state.topics?.[t.key === 'site' ? 'site' : 'cabinet'];
    console.log(`${t.name}: ${r.ok ? 'работает' : `не работает — ${r.reason}`}`);

    if (r.ok) {
      if (s.downSince) {
        const text = `<b>СНОВА РАБОТАЕТ · ${t.name}</b>\n${t.host} снова открывается. Простой ${duration(now - s.downSince)}. Делать ничего не нужно.\n<i>проверка снаружи, GitHub</i>`;
        await say(text, { thread: urgent ?? thread, replyTo: s.msgId });
        if (s.msgId) await telegram('unpinChatMessage', { chat_id: chat, message_id: s.msgId }).catch(() => {});
      }
      state.targets[t.key] = { fails: 0 };
      continue;
    }

    s.fails += 1;
    s.firstFail ??= now;
    if (s.fails < CONFIRM) continue;
    if (!s.downSince) {
      s.downSince = s.firstFail;
      s.lastRemind = now;
      const text = [
        `<b>КРИТИЧНО · ${t.name} не открывается</b>`,
        `Что не работает: ${t.impact}`,
        `Почему: ${r.reason}`,
        ...(allDown ? ['Не открывается ни сайт, ни кабинет — похоже, сбой у самой Amvera. Проверить amvera.ru и их Telegram-канал.'] : []),
        'Что делать:',
        ...t.steps.map((step, i) => `${i + 1}. ${step}`),
        `<i>с ${clock(s.downSince)} МСК · проверка снаружи, GitHub</i>`,
      ].join('\n');
      s.msgId = await say(text, { thread: urgent ?? thread });
      if (s.msgId) await telegram('pinChatMessage', { chat_id: chat, message_id: s.msgId, disable_notification: true }).catch(() => {});
    } else if (now - (s.lastRemind ?? 0) > REMIND_MS) {
      s.lastRemind = now;
      await say(`<b>КРИТИЧНО · ${t.name}</b> — всё ещё не открывается, уже ${duration(now - s.downSince)}. ${r.reason}.`, { thread: urgent ?? thread, replyTo: s.msgId });
    }
  }

  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
}

await main();
