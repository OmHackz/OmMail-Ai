/* OmMail AI console — vanilla ES2018, no build step, no framework.
   The admin secret lives in sessionStorage and is only ever sent in the
   X-Admin-Secret header. */

(() => {
  'use strict';

  const API = '/api/admin';
  const SECRET_KEY = 'ommail.admin.secret';
  const THEME_KEY = 'ommail.theme';

  const state = {
    secret: sessionStorage.getItem(SECRET_KEY) || '',
    view: 'overview',
    settings: null,
    stats: null,
    drafts: [],
    activity: [],
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const el = {
    gate: $('#gate'),
    gateForm: $('#gate-form'),
    gateSecret: $('#gate-secret'),
    gateError: $('#gate-error'),
    shell: $('#shell'),
    main: $('#main'),
    viewTitle: $('#view-title'),
    viewSub: $('#view-sub'),
    statStrip: $('#stat-strip'),
    dailyList: $('#daily-list'),
    dailyStamp: $('#daily-stamp'),
    pendingList: $('#pending-list'),
    pendingMeta: $('#pending-meta'),
    pendingEmpty: $('#pending-empty'),
    queue: $('#queue'),
    queueEmpty: $('#queue-empty'),
    tape: $('#tape'),
    tapeEmpty: $('#tape-empty'),
    conn: $('#conn'),
    modeNote: $('#mode-note'),
    navQueueCount: $('#nav-queue-count'),
    probeForm: $('#probe-form'),
    probeText: $('#probe-text'),
    probeOut: $('#probe-out'),
    settingsForm: $('#settings-form'),
    settingsPrompt: $('#settings-prompt'),
    settingsSignature: $('#settings-signature'),
    settingsToast: $('#settings-toast'),
    connectionList: $('#connection-list'),
    toast: $('#toast'),
  };

  const VIEWS = {
    overview: { title: 'Overview', sub: 'What the auto-responder did today.' },
    queue: { title: 'Reply queue', sub: 'Review each draft before it goes out.' },
    activity: { title: 'Activity', sub: 'Every inbound message, newest first.' },
    settings: { title: 'Settings', sub: 'Shape the assistant and check the connections.' },
  };

  const MODE_NOTES = {
    draft: 'New replies wait for your approval.',
    automatic: 'Replies go out on their own once they pass the safety checks.',
    disabled: 'Automation is off. Inbound mail is still recorded, nothing is sent.',
  };

  const MODE_LABELS = {
    draft: 'Draft',
    automatic: 'Automatic',
    disabled: 'Off',
  };

  /* ------------------------------------------------------------- helpers -- */

  function iconRefresh() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => {
      el.toast.hidden = true;
    }, 4200);
  }

  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function relative(value) {
    if (!value) return '—';
    const date = new Date(value);
    const diff = Date.now() - date.getTime();
    if (Number.isNaN(diff)) return '—';
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.round(hours / 24)} d ago`;
  }

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Secret': state.secret,
        ...(options.headers || {}),
      },
    });

    if (response.status === 401) {
      sessionStorage.removeItem(SECRET_KEY);
      state.secret = '';
      showGate('That secret was not accepted.');
      throw new Error('unauthorized');
    }

    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const message = payload.error ? `Request failed (${payload.error})` : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return payload;
  }

  function showGate(message) {
    el.shell.hidden = true;
    el.gate.hidden = false;
    if (message) {
      el.gateError.textContent = message;
      el.gateError.hidden = false;
    }
  }

  function showConsole() {
    el.gate.hidden = true;
    el.shell.hidden = false;
    el.gateError.hidden = true;
  }

  /* -------------------------------------------------------------- theme -- */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'system';
    applyTheme(saved);
    $('#theme-toggle').addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : current === 'light' ? 'system' : 'dark';
      applyTheme(next);
    });
  }

  /* -------------------------------------------------------------- views -- */

  function setView(view) {
    state.view = view;
    $$('.navitem').forEach((item) => item.classList.toggle('is-active', item.dataset.view === view));
    $$('.view').forEach((section) => {
      section.hidden = section.id !== `view-${view}`;
    });
    el.viewTitle.textContent = VIEWS[view].title;
    el.viewSub.textContent = VIEWS[view].sub;
    if (view === 'queue') loadDrafts();
    if (view === 'activity') loadActivity();
    if (view === 'settings') loadSettings();
  }

  function renderStats(stats) {
    const cells = [
      { label: 'processed', value: stats.processed },
      { label: 'replies written', value: stats.repliesGenerated },
      { label: 'replies sent', value: stats.repliesSent, stamp: true },
      { label: 'waiting', value: stats.draftsPending },
      { label: 'skipped', value: stats.skipped },
      { label: 'failed', value: stats.failed },
    ];

    el.statStrip.innerHTML = '';
    for (const cell of cells) {
      const node = document.createElement('div');
      node.className = `ledger__cell${cell.stamp ? ' ledger__cell--stamp' : ''}`;
      node.innerHTML = `<div class="ledger__value">${cell.value ?? 0}</div><div class="ledger__label">${cell.label}</div>`;
      el.statStrip.appendChild(node);
    }
  }

  function renderTally(target, rows) {
    target.innerHTML = '';
    for (const row of rows) {
      const li = document.createElement('li');
      if (row.alert) li.classList.add('is-alert');
      if (row.quiet) li.classList.add('is-quiet');
      li.innerHTML = `<span>${row.label}</span><b>${row.value}</b>`;
      target.appendChild(li);
    }
  }

  function renderOverview(payload) {
    state.stats = payload.stats;
    renderStats(payload.stats);

    el.dailyStamp.textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    renderTally(el.dailyList, [
      { label: 'messages processed', value: payload.daily.processed },
      { label: 'replies written', value: payload.daily.repliesGenerated },
      { label: 'replies sent', value: payload.daily.repliesSent, alert: payload.daily.repliesSent > 0 },
      { label: 'duplicates ignored', value: payload.daily.duplicates, quiet: true },
      { label: 'skipped by the filters', value: payload.daily.skipped, quiet: true },
      { label: 'failed', value: payload.daily.failed, alert: payload.daily.failed > 0 },
    ]);

    const pending = payload.stats.draftsPending;
    el.pendingMeta.textContent = pending === 1 ? '1 draft' : `${pending} drafts`;
    el.pendingEmpty.hidden = pending > 0;
    renderTally(el.pendingList, [
      { label: 'waiting for approval', value: pending, alert: pending > 0 },
      { label: 'sent in total', value: payload.stats.repliesSent },
      { label: 'escalated for a human', value: payload.stats.escalations, alert: payload.stats.escalations > 0 },
      { label: 'duplicates ignored', value: payload.stats.duplicates, quiet: true },
    ]);
  }

  function renderQueue(drafts) {
    state.drafts = drafts;
    el.queue.innerHTML = '';
    el.queueEmpty.hidden = drafts.length > 0;

    for (const draft of drafts) {
      const letter = document.createElement('article');
      letter.className = 'letter';
      letter.dataset.id = draft.id;

      const stampClass =
        draft.status === 'sent'
          ? 'stamp--sent'
          : draft.status === 'escalated'
            ? 'stamp--escalated'
            : 'stamp--pending';

      const canAct = draft.status === 'pending' || draft.status === 'escalated';

      letter.innerHTML = `
        <div class="letter__perf"></div>
        <div class="letter__body">
          <div class="letter__top">
            <div>
              <h3 class="letter__subject"></h3>
              <p class="letter__from"></p>
            </div>
            <span class="stamp ${stampClass}">${MODE_LABELS[draft.status] || draft.status}</span>
          </div>
          <div class="letter__reply" contenteditable="${canAct}"></div>
          <div class="letter__foot">
            ${
              canAct
                ? `<button class="button button--primary" data-action="approve"><i data-lucide="send"></i>Approve &amp; send</button>
                   <button class="button" data-action="regenerate"><i data-lucide="sparkles"></i>Rewrite</button>
                   <button class="button button--danger" data-action="reject"><i data-lucide="trash-2"></i>Discard</button>`
                : `<span class="card__meta">${draft.sentAt ? `sent ${formatTime(draft.sentAt)}` : draft.status}</span>`
            }
            ${draft.reason ? `<span class="letter__reason">${draft.reason}</span>` : ''}
          </div>
        </div>`;

      letter.querySelector('.letter__subject').textContent = draft.subject;
      letter.querySelector('.letter__from').textContent = `${draft.from} · ${relative(draft.createdAt)}`;
      letter.querySelector('.letter__reply').textContent = draft.text;

      letter.querySelectorAll('[data-action]').forEach((button) => {
        button.addEventListener('click', () => handleDraftAction(draft, button));
      });

      el.queue.appendChild(letter);
    }

    const waiting = drafts.filter((draft) => draft.status === 'pending' || draft.status === 'escalated').length;
    el.navQueueCount.hidden = waiting === 0;
    el.navQueueCount.textContent = String(waiting);

    iconRefresh();
  }

  async function handleDraftAction(draft, button) {
    const action = button.dataset.action;
    button.disabled = true;
    try {
      if (action === 'approve') {
        const edited = letterText(draft.id);
        await api(`/drafts/${draft.id}/approve`, {
          method: 'POST',
          body: JSON.stringify({ text: edited }),
        });
        button.classList.add('is-done');
        toast('Reply sent.');
      } else if (action === 'reject') {
        await api(`/drafts/${draft.id}/reject`, { method: 'POST', body: JSON.stringify({}) });
        toast('Draft discarded.');
      } else if (action === 'regenerate') {
        await api(`/drafts/${draft.id}/regenerate`, { method: 'POST', body: JSON.stringify({}) });
        toast('Rewritten with the assistant.');
      }
      await Promise.all([loadDrafts(), loadOverview()]);
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  }

  function letterText(id) {
    const node = document.querySelector(`.letter[data-id="${id}"] .letter__reply`);
    return node ? node.textContent.trim() : '';
  }

  function renderTape(entries) {
    el.tape.innerHTML = '';
    el.tapeEmpty.hidden = entries.length > 0;

    for (const entry of entries) {
      const li = document.createElement('li');
      const state = entry.state || '';
      if (state === 'sent') li.classList.add('is-sent');
      if (state === 'failed' || state === 'send_uncertain') li.classList.add('is-failed');
      if (state === 'skipped') li.classList.add('is-skipped');

      const detail = [entry.subject, entry.sender, entry.detail, entry.errorCode].filter(Boolean).join(' · ');
      li.innerHTML = `
        <div class="tape__head">
          <span class="tape__event"></span>
          <span class="tape__time">${formatTime(entry.ts)}</span>
        </div>
        <p class="tape__detail"></p>`;
      li.querySelector('.tape__event').textContent = entry.event;
      li.querySelector('.tape__detail').textContent = detail;
      el.tape.appendChild(li);
    }
  }

  function renderSettings(payload) {
    state.settings = payload.settings;
    el.settingsPrompt.value = payload.settings.systemPrompt || '';
    el.settingsSignature.value = payload.settings.signature || '';

    const mode = payload.settings.mode;
    $$('.segmented button').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.mode === mode);
    });
    el.modeNote.textContent = MODE_NOTES[mode] || '';

    const enabled = payload.settings.enabled;
    const note = el.modeNote;
    if (!enabled) {
      note.textContent = 'Automation is paused. Choose a mode to turn it back on.';
    } else {
      note.textContent = MODE_NOTES[mode] || '';
    }
  }

  function renderConnection(payload) {
    el.connectionList.innerHTML = '';
    const rows = [
      { label: 'DeoMail API', value: payload.deomail.ok ? 'reachable' : payload.deomail.error || 'unreachable', alert: !payload.deomail.ok },
      { label: 'Agnes AI', value: payload.agnes.ok ? `reachable (${payload.agnes.model})` : payload.agnes.error || 'unreachable', alert: !payload.agnes.ok },
    ];
    for (const row of rows) {
      const li = document.createElement('li');
      if (row.alert) li.classList.add('is-alert');
      li.innerHTML = `<span>${row.label}</span><b></b>`;
      li.querySelector('b').textContent = row.value;
      el.connectionList.appendChild(li);
    }
  }

  /* -------------------------------------------------------------- loaders -- */

  async function loadOverview() {
    const payload = await api('');
    renderOverview(payload);
    renderSettings(payload);
  }

  async function loadDrafts() {
    const payload = await api('/drafts?limit=100');
    renderQueue(payload.drafts || []);
  }

  async function loadActivity() {
    const payload = await api('/activity?limit=80');
    renderTape(payload.activity || []);
  }

  async function loadSettings() {
    const payload = await api('/settings');
    renderSettings(payload);
    const connection = await api('/connection');
    renderConnection(connection);
    setConnection(connection.deomail.ok && connection.agnes.ok);
  }

  function setConnection(ok) {
    el.conn.classList.toggle('is-ok', ok);
    el.conn.classList.toggle('is-bad', !ok);
    el.conn.querySelector('.conn__text').textContent = ok ? 'DeoMail and Agnes AI are reachable' : 'a connection needs attention';
  }

  async function refreshAll() {
    try {
      await loadOverview();
      if (state.view === 'queue') await loadDrafts();
      if (state.view === 'activity') await loadActivity();
      if (state.view === 'settings') await loadSettings();
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.message);
    }
  }

  /* --------------------------------------------------------------- wiring -- */

  function wire() {
    el.gateForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const secret = el.gateSecret.value.trim();
      if (!secret) return;
      state.secret = secret;
      try {
        await api('');
        sessionStorage.setItem(SECRET_KEY, secret);
        el.gateSecret.value = '';
        showConsole();
        await refreshAll();
      } catch (error) {
        if (error.message !== 'unauthorized') {
          el.gateError.textContent = error.message;
          el.gateError.hidden = false;
        }
      }
    });

    $$('.navitem').forEach((item) => {
      item.addEventListener('click', () => setView(item.dataset.view));
    });

    $$('.segmented button').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!state.secret) return;
        try {
          await api('/settings', { method: 'POST', body: JSON.stringify({ mode: button.dataset.mode, enabled: true }) });
          await loadOverview();
          toast(`Mode set to ${MODE_LABELS[button.dataset.mode]}.`);
        } catch (error) {
          toast(error.message);
        }
      });
    });

    el.settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('/settings', {
          method: 'POST',
          body: JSON.stringify({
            systemPrompt: el.settingsPrompt.value.trim() || null,
            signature: el.settingsSignature.value.trim() || null,
          }),
        });
        el.settingsToast.textContent = 'Settings saved.';
        el.settingsToast.hidden = false;
        window.setTimeout(() => {
          el.settingsToast.hidden = true;
        }, 3000);
        await loadSettings();
      } catch (error) {
        toast(error.message);
      }
    });

    el.probeForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = el.probeText.value.trim();
      if (!message) return;
      el.probeOut.hidden = false;
      el.probeOut.textContent = 'Thinking…';
      try {
        const payload = await api('/test-ai', { method: 'POST', body: JSON.stringify({ message }) });
        el.probeOut.textContent = payload.reply || '(empty reply)';
      } catch (error) {
        el.probeOut.textContent = error.message;
      }
    });

    $('#refresh').addEventListener('click', refreshAll);

    $('#sign-out').addEventListener('click', () => {
      sessionStorage.removeItem(SECRET_KEY);
      state.secret = '';
      showGate();
    });
  }

  /* ---------------------------------------------------------------- boot -- */

  async function boot() {
    initTheme();
    wire();
    iconRefresh();

    if (!state.secret) {
      showGate();
      el.gateSecret.focus();
      return;
    }

    try {
      await api('');
      showConsole();
      await refreshAll();
    } catch (error) {
      if (error.message !== 'unauthorized') {
        showGate(error.message);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
