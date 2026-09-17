/**
 * 揪咖 JioKa2 — 前端主程式（Vanilla JS，hash routing SPA，Firebase 版）
 * 需先於 config.js 設定 window.JIOKA_CONFIG.firebase 與 GOOGLE_CLIENT_ID
 */
'use strict';
import { auth, signInWithGoogleIdToken, signOut as fbSignOut, onAuthStateChanged } from './firebase-init.js';
import * as Data from './data.js';

// ===================== 全域狀態 =====================
const State = {
  user: null,          // {uid, email, name}
  eventData: null,     // 目前活動 payload
  eventId: null,
  unsubEvent: null,    // 即時同步（取代原本輪詢計時器）
  selectedDate: null,  // 月曆上被點開的日期
  myVotes: new Set(),  // 本地樂觀投票狀態
  voteTimer: null,     // 投票 debounce
  gisReady: false,
};

// ===================== 小工具 =====================
const $ = function (sel) { return document.querySelector(sel); };
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function fmtMD(dateStr) {
  const p = String(dateStr).split('-');
  return Number(p[1]) + '/' + Number(p[2]);
}
function fmtDT(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function eventLink(eventId) {
  return location.origin + location.pathname + '#/e/' + eventId;
}
function errMsg(e) {
  // data.js 的 fail() 丟出的錯誤 code 是自訂的大寫代碼（例如 BAD_REQUEST），訊息本身就是給使用者看的中文
  if (e && e.code && /^[A-Z_]+$/.test(e.code)) return e.message;
  // 其餘是 Firestore SDK 原生錯誤（例如 permission-denied），换成一句通用中文說明
  if (e && e.code === 'permission-denied') return '權限不足，或不符合目前的活動狀態（例如投票已截止）';
  return (e && e.message) || '發生錯誤，請稍後再試';
}
const STAR_SVG = '<svg class="star-burst" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 1 L24 13 L37 9 L28 19 L39 26 L25 26 L27 39 L20 28 L13 39 L15 26 L1 26 L12 19 L3 9 L16 13 Z" fill="currentColor" stroke="#1B1B1B" stroke-width="2"/></svg>';
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// ===================== Toast / Modal =====================
function toast(msg, type) {
  const root = $('#toast-root');
  const t = document.createElement('div');
  t.className = 'toast ' + (type || '');
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2800);
  setTimeout(function () { t.remove(); }, 3200);
}
function openModal(html) {
  $('#modal-root').innerHTML =
    '<div class="modal-mask" onclick="if(event.target===this)App.closeModal()"><div class="modal">' + html + '</div></div>';
}
function closeModal() { $('#modal-root').innerHTML = ''; }
function confirmModal(title, message, yesLabel, onYes) {
  openModal(
    '<h3>' + esc(title) + '</h3>' +
    '<p style="line-height:1.7">' + esc(message) + '</p>' +
    '<div class="modal-actions">' +
    '<button class="btn btn-white" onclick="App.closeModal()">取消</button>' +
    '<button class="btn btn-pink" id="confirm-yes-btn">' + esc(yesLabel || '確定') + '</button>' +
    '</div>'
  );
  $('#confirm-yes-btn').onclick = function () { closeModal(); onYes(); };
}

// ===================== Google 登入（GIS 產生 idToken，交給 Firebase Auth 驗證）=====================
const Auth = {
  init: function () {
    onAuthStateChanged(auth, function (fbUser) {
      State.user = fbUser ? {
        uid: fbUser.uid,
        email: String(fbUser.email || '').toLowerCase(),
        name: fbUser.displayName || fbUser.email,
      } : null;
      renderTopbar();
      route();
    });
    let tries = 0;
    const timer = setInterval(function () {
      tries++;
      if (window.google && google.accounts && google.accounts.id) {
        clearInterval(timer);
        State.gisReady = true;
        google.accounts.id.initialize({
          client_id: JIOKA_CONFIG.GOOGLE_CLIENT_ID,
          callback: Auth.onCredential,
          auto_select: true,
        });
        renderTopbar();
      } else if (tries > 40) { clearInterval(timer); }
    }, 250);
  },
  onCredential: async function (resp) {
    try {
      await signInWithGoogleIdToken(resp.credential);
      closeModal();
      toast('歡迎回來！', 'ok');
    } catch (e) {
      toast('登入失敗，請再試一次', 'err');
    }
  },
  signOut: function (silent) {
    fbSignOut();
    if (State.gisReady) { try { google.accounts.id.disableAutoSelect(); } catch (e) {} }
    if (!silent) route();
  },
  requireLogin: function () {
    if (State.user) return true;
    openModal(
      '<h3>先登入才能揪咖！</h3>' +
      '<p style="line-height:1.7;margin-bottom:12px">使用 Google 帳號登入，只取 Email 與顯示名稱，不存密碼。</p>' +
      '<div id="modal-google-btn" style="display:flex;justify-content:center"></div>'
    );
    Auth.renderButton($('#modal-google-btn'));
    return false;
  },
  renderButton: function (el) {
    if (!el) return;
    if (!State.gisReady) {
      el.innerHTML = '<span class="hint">登入元件載入中…</span>';
      setTimeout(function () { Auth.renderButton(el); }, 500);
      return;
    }
    el.innerHTML = '';
    google.accounts.id.renderButton(el, {
      theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', locale: 'zh_TW', width: 240,
    });
  },
};

// ===================== 頂欄 =====================
function renderTopbar() {
  const el = $('#topbar');
  const right = State.user
    ? '<span class="user-chip"><span class="avatar">' + esc(State.user.name[0] || '我') + '</span>' +
      esc(State.user.name) + '</span>' +
      '<button class="btn btn-sm btn-white" onclick="App.signOut()">登出</button>'
    : '<span id="topbar-google-btn"></span>';
  el.innerHTML =
    '<a class="brand" href="#/"><span class="logo">揪咖 JioKa</span><span class="sub">揪團排程小工具</span></a>' +
    '<div class="topbar-right">' + right + '</div>';
  if (!State.user) Auth.renderButton($('#topbar-google-btn'));
}
// ===================== 路由 =====================
function stopSync() {
  if (State.unsubEvent) { State.unsubEvent(); State.unsubEvent = null; }
}
function route() {
  stopSync();
  const hash = location.hash || '#/';
  let m;
  if ((m = hash.match(/^#\/e\/([A-Za-z0-9]+)(\/results|\/admin)?$/))) {
    const id = m[1], sub = m[2] || '';
    if (sub === '/results') renderResults(id);
    else if (sub === '/admin') renderAdmin(id);
    else renderVote(id);
  } else if (hash.indexOf('#/new') === 0) {
    renderNew(hash);
  } else {
    renderHome();
  }
  window.scrollTo(0, 0);
}

// ===================== 分享 Modal =====================
function shareModal(eventId, title) {
  const url = eventLink(eventId);
  const lineUrl = 'https://line.me/R/msg/text/?' + encodeURIComponent('【揪咖】' + title + ' 來投票吧！\n' + url);
  openModal(
    '<h3>把連結丟給大家！</h3>' +
    '<div class="field"><label>活動連結</label>' +
    '<input class="input" id="share-url-input" readonly value="' + esc(url) + '" onclick="this.select()"></div>' +
    '<div class="modal-actions">' +
    '<a class="btn btn-mint" href="' + esc(lineUrl) + '" target="_blank" rel="noopener">LINE 分享</a>' +
    '<button class="btn btn-yellow" id="share-copy-btn">複製連結</button>' +
    '</div>'
  );
  $('#share-copy-btn').onclick = function () { copyText(url); };
}
function copyText(text) {
  function done() { toast('已複製！', 'ok'); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
  } else { fallbackCopy(text); done(); }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  ta.remove();
}

// ===================== 首頁 =====================
function statusBadge(status) {
  const map = { open: ['投票中', 'status-open'], closed: ['已截止', 'status-closed'], confirmed: ['已確定', 'status-confirmed'] };
  const s = map[status] || ['投票中', 'status-open'];
  return '<span class="status-badge ' + s[1] + '">' + s[0] + '</span>';
}
function renderHome() {
  const view = $('#view');
  view.innerHTML =
    '<div class="card hero">' +
      '<h1>揪咖 JioKa</h1>' +
      '<p>大家一起選日子、票選地點<br>揪團排程，就是這麼開心！</p>' +
      '<button class="btn btn-pink btn-lg" onclick="App.goNew()">🎉 發起揪咖</button>' +
    '</div>' +
    '<div class="card card-white">' +
      '<div class="card-title">🔑 用活動代碼進入</div>' +
      '<div class="comment-input-row">' +
        '<input class="input" id="join-code" placeholder="輸入 8 碼活動代碼" maxlength="8" style="text-transform:uppercase">' +
        '<button class="btn btn-yellow" onclick="App.joinByCode()">進入</button>' +
      '</div>' +
    '</div>' +
    '<div id="my-events-area">' +
      (State.user
        ? '<div class="loading-card"><div class="loading-star">★</div><p>翻找你的揪咖紀錄…</p></div>'
        : '<div class="card"><div class="card-title">📒 我的揪咖紀錄</div>' +
          '<div class="empty-state">登入後，這裡會列出你發起與參加過的所有活動，<br>每一場開心的投票都幫你留著！</div>' +
          '<div style="display:flex;justify-content:center;margin-top:10px" id="home-google-btn"></div></div>') +
    '</div>';
  if (!State.user) Auth.renderButton($('#home-google-btn'));
  else loadMyEvents();
}
async function loadMyEvents() {
  const area = $('#my-events-area');
  try {
    const data = await Data.listMyEvents(State.user);
    if (!area.isConnected) return;
    area.innerHTML = myEventsHtml(data);
  } catch (e) {
    if (area.isConnected) area.innerHTML = '<div class="card"><div class="empty-state">紀錄讀取失敗：' + esc(errMsg(e)) + '</div></div>';
  }
}
function eventListHtml(list, emptyText) {
  if (!list.length) return '<div class="empty-state">' + emptyText + '</div>';
  return list.map(function (ev) {
    return '<a class="event-item" href="#/e/' + esc(ev.eventId) + '">' +
      '<div class="info"><div class="t">' + esc(ev.title) + '</div>' +
      '<div class="m">' + ev.participantCount + ' 人參與・建立於 ' + fmtDT(ev.createdAt) + '</div></div>' +
      statusBadge(ev.status) + '</a>';
  }).join('');
}
function myEventsHtml(data) {
  let html = '';
  html += '<div class="card"><div class="card-title">👑 我發起的</div>' + eventListHtml(data.owned, '還沒發起過活動，點上面「發起揪咖」開第一團！') + '</div>';
  if (data.coadmin.length) {
    html += '<div class="card"><div class="card-title">🤝 我幫忙管理的</div>' + eventListHtml(data.coadmin, '') + '</div>';
  }
  html += '<div class="card"><div class="card-title">🙋 我參加的</div>' + eventListHtml(data.joined, '還沒參加過活動，跟朋友要個連結吧！') + '</div>';
  return html;
}
// ===================== 月曆元件（共用） =====================
const SLOT_PRESETS = {
  '一日遊': ['全天', '上午', '下午'],
  '聚餐': ['中午', '晚上'],
  '聚會': ['下午', '晚上'],
};
function slotPresetsFor(types) {
  const slots = [];
  (types || []).forEach(function (t) {
    (SLOT_PRESETS[t] || []).forEach(function (s) { if (slots.indexOf(s) < 0) slots.push(s); });
  });
  return slots.length ? slots : ['全天', '上午', '下午', '晚上'];
}
/** 月曆固定顯示「這週的週日」到「今天往後一個月」，不提供翻頁——回傳 {start: Date, weeks: 週數} */
function calendarRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  const end = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const totalDays = Math.round((end - start) / 86400000) + 1;
  return { start: start, weeks: Math.ceil(totalDays / 7) };
}
/**
 * 產生月曆 HTML（固定範圍：這週日～往後一個月，見 calendarRange）。
 * marked: { 'YYYY-MM-DD': {count, allOk, mine, candidate} }
 * opts: { interactive: bool（候選日期可點）, pickAny: bool（任何日期可點，建立模式用） }
 */
function calendarHtml(marked, opts) {
  opts = opts || {};
  marked = marked || {};
  const range = calendarRange();
  const today = todayStr();
  let html = '<div class="cal-grid">';
  WEEKDAYS.forEach(function (w, i) {
    html += '<div class="cal-dow' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '') + '">' + w + '</div>';
  });
  for (let i = 0; i < range.weeks * 7; i++) {
    const d = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() + i);
    const y = d.getFullYear(), m = d.getMonth() + 1, dayNum = d.getDate();
    const dateStr = y + '-' + pad2(m) + '-' + pad2(dayNum);
    const disp = (dayNum === 1 || i === 0) ? (m + '/' + dayNum) : String(dayNum);
    const mk = marked[dateStr];
    const total = State.eventData ? State.eventData.event.participantCount : 0;
    let cls = 'cal-day', inner = disp;
    if (mk && mk.candidate) {
      cls += ' candidate';
      if (mk.allOk) { /* 全員 OK 蓋星 */ }
      else if (total > 0 && mk.count >= Math.ceil(total / 2) && mk.count > 0) cls += ' heat-half';
      else if (mk.count > 0) cls += ' heat-some';
      if (mk.mine) cls += ' mine';
      if (mk.count > 0) inner += '<span class="cnt">' + mk.count + '人</span>';
    } else if (opts.pickAny) {
      cls += ' candidate';
    }
    if (dateStr === today) cls += ' today';
    if (State.selectedDate === dateStr) cls += ' mine';
    const isPast = dateStr < today;
    if (isPast) cls += ' past-day';
    const clickable = (opts.pickAny || (mk && mk.candidate)) && !opts.readonly && !isPast;
    const onclick = clickable ? ' onclick="App.pickDate(\'' + dateStr + '\')"' : '';
    const style = isPast ? ' style="opacity:.4;cursor:default"' : '';
    const star = (mk && mk.allOk && mk.candidate) ? STAR_SVG : '';
    html += '<div class="cal-cell"><div class="' + cls + '"' + onclick + style + '>' + star + inner + '</div></div>';
  }
  html += '</div>';
  return html;
}
function calendarHeaderHtml() {
  const range = calendarRange();
  const end = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate() + range.weeks * 7 - 1);
  const label = (range.start.getMonth() + 1) + '/' + range.start.getDate() + ' – ' + (end.getMonth() + 1) + '/' + end.getDate();
  return '<div class="cal-header"><div class="cal-title">' + label + '</div></div>';
}
function calLegendHtml() {
  return '<div class="cal-legend">' +
    '<span class="lg"><span class="lg-dot white"></span>0人</span>' +
    '<span class="lg"><span class="lg-dot some"></span>少數</span>' +
    '<span class="lg"><span class="lg-dot half"></span>過半</span>' +
    '<span class="lg"><span class="lg-star">★</span>全員 OK！</span></div>';
}

// ===================== 時段選擇 Modal（建立/新增日期共用） =====================
let _slotPicked = new Set();
/**
 * dateStr 的時段挑選。
 * takenSlots: 已存在不可再選的時段（字串陣列）
 * onConfirm(slotsArray) 回呼
 */
function slotPickerModal(dateStr, presets, takenSlots, titleText, onConfirm) {
  _slotPicked = new Set();
  const taken = takenSlots || [];
  const chips = presets.map(function (s) {
    const dis = taken.indexOf(s) >= 0;
    return '<button class="chip' + (dis ? '' : ' slot-pick') + '" ' + (dis ? 'disabled style="opacity:.4"' : '') +
      ' data-slot="' + esc(s) + '">' + esc(s) + (dis ? ' ✓已有' : '') + '</button>';
  }).join('');
  openModal(
    '<h3>' + esc(titleText || ('加入 ' + fmtMD(dateStr) + ' 的時段')) + '</h3>' +
    '<div class="field"><label>選擇時段（可複選）</label>' +
    '<div class="chip-row" id="slot-pick-row">' + chips + '</div></div>' +
    '<div class="field"><label>或自訂時段</label>' +
    '<div class="comment-input-row"><input class="input" id="slot-custom" maxlength="10" placeholder="例如：傍晚">' +
    '<button class="btn btn-sm btn-mint" id="slot-custom-add">加入</button></div></div>' +
    '<div class="modal-actions">' +
    '<button class="btn btn-white" onclick="App.closeModal()">取消</button>' +
    '<button class="btn btn-yellow" id="slot-confirm-btn">確定加入</button></div>'
  );
  document.querySelectorAll('.slot-pick').forEach(function (btn) {
    btn.onclick = function () {
      const s = btn.dataset.slot;
      if (_slotPicked.has(s)) { _slotPicked.delete(s); btn.classList.remove('on'); }
      else { _slotPicked.add(s); btn.classList.add('on'); }
    };
  });
  $('#slot-custom-add').onclick = function () {
    const v = $('#slot-custom').value.trim();
    if (!v) return;
    if (taken.indexOf(v) >= 0 || _slotPicked.has(v)) { toast('「' + v + '」已經有了'); return; }
    _slotPicked.add(v);
    const tag = document.createElement('span');
    tag.className = 'chip on'; tag.textContent = v;
    $('#slot-pick-row').appendChild(tag);
    $('#slot-custom').value = '';
  };
  $('#slot-confirm-btn').onclick = function () {
    const slots = Array.from(_slotPicked);
    if (!slots.length) { toast('請至少選一個時段'); return; }
    closeModal();
    onConfirm(slots);
  };
}
// ===================== 建立活動 =====================
const NewForm = { types: new Set(), dateSlots: {}, sourceEventId: null };

async function renderNew(hash) {
  const view = $('#view');
  if (!State.user) {
    view.innerHTML = '<div class="card"><div class="empty-state">發起揪咖前，請先登入 Google 帳號。</div></div>';
    Auth.requireLogin();
    return;
  }
  const m = String(hash).match(/[?&]from=([A-Za-z0-9]+)/);
  NewForm.sourceEventId = m ? m[1] : null;
  NewForm.types = new Set();
  NewForm.dateSlots = {};
  let prefill = null;
  if (NewForm.sourceEventId) {
    view.innerHTML = '<div class="loading-card"><div class="loading-star">★</div><p>複製上一場的設定…</p></div>';
    try { prefill = await Data.getEventPayload(NewForm.sourceEventId, State.user); }
    catch (e) { toast('讀取原活動失敗，改為全新建立', 'err'); NewForm.sourceEventId = null; }
  }
  if (prefill) prefill.event.types.forEach(function (t) { NewForm.types.add(t); });
  const prePlaces = prefill ? prefill.options.places : [];

  view.innerHTML =
    '<div class="card">' +
      '<div class="card-title">' + (NewForm.sourceEventId ? '🔁 再揪一次（地點已幫你複製）' : '🎉 發起揪咖') + '</div>' +
      '<div class="field"><label>活動名稱 *</label>' +
        '<input class="input" id="nf-title" maxlength="50" placeholder="例如：週末爬山團" value="' + esc(prefill ? prefill.event.title + ' 再一攤' : '') + '"></div>' +
      '<div class="field"><label>活動類型（可複選，影響預設時段）</label>' +
        '<div class="chip-row" id="nf-types">' +
          ['一日遊', '聚餐', '聚會'].map(function (t) {
            return '<button class="chip' + (NewForm.types.has(t) ? ' on' : '') + '" data-type="' + t + '">' + t + '</button>';
          }).join('') +
        '</div></div>' +
      '<div class="field"><label>說明文字</label>' +
        '<textarea class="textarea" id="nf-desc" maxlength="500" placeholder="想跟大家說的話…">' + esc(prefill ? prefill.event.description : '') + '</textarea></div>' +
      '<div class="field"><label>投票截止時間（可留空代表不設限）</label>' +
        '<input class="input" id="nf-deadline" type="datetime-local"></div>' +
    '</div>' +
    '<div><span class="section-label yellow">選日期</span>' +
      '<div class="card card-white"><div id="nf-cal"></div>' +
        '<div class="hint">點月曆上的日期，為那天挑一個或多個時段。</div>' +
        '<div id="nf-picked" class="mt8"></div>' +
      '</div>' +
    '</div>' +
    '<div><span class="section-label mint">選地點</span>' +
      '<div class="card card-white"><div id="nf-places"></div>' +
        '<button class="btn btn-sm btn-mint" onclick="App.addPlaceRow()">＋ 加一個地點</button>' +
      '</div>' +
    '</div>' +
    '<button class="btn btn-pink btn-lg" id="nf-submit">🚀 建立活動，取得分享連結！</button>';

  document.querySelectorAll('#nf-types .chip').forEach(function (btn) {
    btn.onclick = function () {
      const t = btn.dataset.type;
      if (NewForm.types.has(t)) { NewForm.types.delete(t); btn.classList.remove('on'); }
      else { NewForm.types.add(t); btn.classList.add('on'); }
    };
  });
  prePlaces.forEach(function (p) { addPlaceRow(p.placeName, p.mapLink); });
  if (!prePlaces.length) addPlaceRow('', '');
  renderNewCalendar();
  renderNewPicked();
  $('#nf-submit').onclick = submitNew;
}
function addPlaceRow(name, link) {
  const wrap = $('#nf-places');
  const row = document.createElement('div');
  row.className = 'place-row mb8';
  row.innerHTML =
    '<input class="input mb8 place-name-input" maxlength="50" placeholder="地點名稱，例如：貓空茶屋" value="' + esc(name || '') + '">' +
    '<div class="comment-input-row">' +
      '<input class="input place-link-input" placeholder="Google Map 連結（可留空）" value="' + esc(link || '') + '">' +
      '<button class="btn btn-sm btn-white place-del-btn">✕</button>' +
    '</div>';
  row.querySelector('.place-del-btn').onclick = function () {
    if (document.querySelectorAll('.place-row').length > 1) row.remove();
    else { row.querySelector('.place-name-input').value = ''; row.querySelector('.place-link-input').value = ''; }
  };
  wrap.appendChild(row);
}
function renderNewCalendar() {
  const marked = {};
  Object.keys(NewForm.dateSlots).forEach(function (d) {
    marked[d] = { candidate: true, mine: true, count: 0 };
  });
  $('#nf-cal').innerHTML =
    calendarHeaderHtml() +
    calendarHtml(marked, { pickAny: true });
}
function renderNewPicked() {
  const area = $('#nf-picked');
  const dates = Object.keys(NewForm.dateSlots).sort();
  if (!dates.length) { area.innerHTML = ''; return; }
  area.innerHTML = '<div class="chip-row">' + dates.map(function (d) {
    return NewForm.dateSlots[d].map(function (s) {
      return '<span class="chip on">' + fmtMD(d) + ' ' + esc(s) +
        ' <b class="new-slot-del-btn" style="cursor:pointer" data-date="' + esc(d) + '" data-slot="' + esc(s) + '">✕</b></span>';
    }).join('');
  }).join('') + '</div>';
  document.querySelectorAll('.new-slot-del-btn').forEach(function (btn) {
    btn.onclick = function () { App.removeNewSlot(btn.dataset.date, btn.dataset.slot); };
  });
}

async function submitNew() {
  const title = $('#nf-title').value.trim();
  if (!title) { toast('請填活動名稱', 'err'); $('#nf-title').focus(); return; }
  const dates = [];
  Object.keys(NewForm.dateSlots).forEach(function (d) {
    NewForm.dateSlots[d].forEach(function (s) { dates.push({ date: d, timeSlot: s }); });
  });
  const places = [];
  document.querySelectorAll('.place-row').forEach(function (row) {
    const name = row.querySelector('.place-name-input').value.trim();
    if (name) places.push({ placeName: name, mapLink: row.querySelector('.place-link-input').value.trim() });
  });
  if (!dates.length && !places.length) { toast('請至少加一個候選日期或地點', 'err'); return; }
  const dlVal = $('#nf-deadline').value;
  const params = {
    title: title, types: Array.from(NewForm.types),
    description: $('#nf-desc').value.trim(),
    dates: dates, places: places,
    deadline: dlVal ? new Date(dlVal).toISOString() : '',
  };
  const btn = $('#nf-submit');
  btn.disabled = true; btn.textContent = '建立中…';
  try {
    let r;
    if (NewForm.sourceEventId) {
      r = await Data.duplicateEvent(State.user, Object.assign({ sourceEventId: NewForm.sourceEventId }, params));
    } else {
      r = await Data.createEvent(State.user, params);
    }
    location.hash = '#/e/' + r.eventId;
    setTimeout(function () { shareModal(r.eventId, title); }, 400);
  } catch (e) {
    toast(errMsg(e), 'err');
    btn.disabled = false; btn.textContent = '🚀 建立活動，取得分享連結！';
  }
}
// ===================== 投票頁 =====================
async function renderVote(eventId) {
  State.eventId = eventId;
  State.selectedDate = null;
  const view = $('#view');
  view.innerHTML = '<div class="loading-card"><div class="loading-star">★</div><p>揪咖資料載入中…</p></div>';
  try {
    const data = await Data.getEventPayload(eventId, State.user);
    State.eventData = data;
    State.myVotes = new Set(data.me ? data.me.votes : []);
    renderVoteMain(false);
    startSync();
  } catch (e) {
    view.innerHTML = '<div class="card"><div class="empty-state">😢 ' + esc(errMsg(e)) +
      '<br><br><a class="btn btn-yellow" href="#/">回首頁</a></div></div>';
  }
}

function resultCardHtml(data) {
  const ev = data.event;
  const datePart = ev.confirmedDateLabel || '（日期未指定）';
  const placePart = ev.confirmedPlaceName
    ? (ev.confirmedPlaceLink
      ? '<a href="' + esc(ev.confirmedPlaceLink) + '" target="_blank" rel="noopener" style="color:var(--ink)">' + esc(ev.confirmedPlaceName) + ' 🗺️</a>'
      : esc(ev.confirmedPlaceName))
    : '（地點未指定）';
  return '<div class="result-card mb16">' +
    '<svg class="star-deco" style="top:-20px;left:-20px" viewBox="0 0 40 40"><path d="M20 1 L24 13 L37 9 L28 19 L39 26 L25 26 L27 39 L20 28 L13 39 L15 26 L1 26 L12 19 L3 9 L16 13 Z" fill="currentColor"/></svg>' +
    '<div class="rc-title">🎊 最終確定方案 🎊</div>' +
    '<div class="rc-main">' + esc(ev.title) + '</div>' +
    '<div class="rc-place">📅 ' + esc(datePart) + '<br>📍 ' + placePart + '</div>' +
    '<div class="hint mt8">' + ev.participantCount + ' 人參與投票・主揪：' + esc(ev.adminNickname) + '</div>' +
    '</div>';
}

function deadlineBannerHtml(data) {
  const ev = data.event;
  if (ev.status === 'confirmed') return '<div class="deadline-banner closed">🎊 本場投票已圓滿結束，結果出爐！</div>';
  if (ev.status === 'closed') return '<div class="deadline-banner closed">🔒 投票已截止（仍可查看結果）</div>';
  if (ev.deadline) {
    const left = new Date(ev.deadline).getTime() - Date.now();
    if (left <= 0) return '<div class="deadline-banner closed">🔒 投票時間到，已截止！</div>';
    const urgent = left < 24 * 3600 * 1000;
    return '<div class="deadline-banner' + (urgent ? ' urgent' : '') + '">⏰ 投票截止：' + fmtDT(ev.deadline) + (urgent ? '，快投！' : '') + '</div>';
  }
  return '<div class="deadline-banner">🖐️ 不限投票時間，投起來！</div>';
}

function eventHeaderCardHtml(data) {
  const ev = data.event;
  const me = data.me;
  const role = me ? me.role : 'guest';
  const typeChips = ev.types.map(function (t) { return '<span class="chip on" style="cursor:default">' + esc(t) + '</span>'; }).join('');
  let buttons = '<button class="btn btn-sm btn-mint" onclick="App.shareCurrent()">📤 分享</button>' +
    '<a class="btn btn-sm btn-yellow" href="#/e/' + esc(ev.eventId) + '/results">📊 結果統計</a>';
  if (role === 'owner' || role === 'coadmin') {
    buttons += '<a class="btn btn-sm btn-pink" href="#/e/' + esc(ev.eventId) + '/admin">🛠️ 管理後台</a>';
  }
  if (me) buttons += '<a class="btn btn-sm btn-white" href="#/new?from=' + esc(ev.eventId) + '">🔁 再揪一次</a>';
  const nickChip = me
    ? (me.nickname
      ? '<button class="btn btn-sm btn-white" onclick="App.nicknameModal()">😎 我是 ' + esc(me.nickname) + ' ✎</button>'
      : '<button class="btn btn-sm btn-pink" onclick="App.nicknameModal()">✏️ 設定暱稱</button>')
    : '';
  return '<div class="card">' +
    '<div class="card-title" style="font-size:22px">' + esc(ev.title) + '</div>' +
    (typeChips ? '<div class="chip-row mb8">' + typeChips + '</div>' : '') +
    (ev.description ? '<p style="line-height:1.7;margin-bottom:10px">' + esc(ev.description) + '</p>' : '') +
    deadlineBannerHtml(data) +
    '<div class="hint mt8">主揪：' + esc(ev.adminNickname) + '・' + ev.participantCount + ' 人參與・代碼 ' + esc(ev.eventId) + '</div>' +
    '<div class="gap8 mt8">' + buttons + nickChip + '</div>' +
    '</div>';
}

// ---- 暱稱 Modal ----
function nicknameModal() {
  if (!State.user) { Auth.requireLogin(); return; }
  openModal(
    '<h3>設定你在本場的暱稱</h3>' +
    '<div class="field"><input class="input" id="nick-input" maxlength="20" placeholder="例如：阿翔" value="' +
      esc(State.eventData && State.eventData.me && State.eventData.me.nickname ? State.eventData.me.nickname : '') + '"></div>' +
    '<div class="hint">同一場活動內暱稱要獨一無二，大家才認得你。</div>' +
    '<div class="error-text" id="nick-err"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn btn-white" onclick="App.closeModal()">取消</button>' +
    '<button class="btn btn-yellow" id="nick-save">就決定是你了！</button></div>'
  );
  const input = $('#nick-input'), err = $('#nick-err');
  let timer = null;
  input.oninput = function () {
    err.textContent = '';
    clearTimeout(timer);
    const v = input.value.trim();
    if (!v) return;
    timer = setTimeout(async function () {
      try {
        const r = await Data.checkNickname(State.eventId, State.user.uid, v);
        err.textContent = r.available ? '' : r.reason;
      } catch (e) { /* 靜默 */ }
    }, 350);
  };
  $('#nick-save').onclick = async function () {
    const v = input.value.trim();
    if (!v) { err.textContent = '暱稱不能為空'; return; }
    try {
      await Data.setNickname(State.eventId, State.user, v);
      closeModal();
      toast('暱稱設定完成：' + v, 'ok');
      forceRefreshEvent();
    } catch (e) { err.textContent = errMsg(e); }
  };
}
// ---- 投票頁：日期區 ----
function leadingMessage(data) {
  const ds = data.stats.dates;
  if (!ds.length) return '';
  let best = ds[0];
  ds.forEach(function (d) { if (d.voterCount > best.voterCount) best = d; });
  if (best.voterCount === 0) return '還沒有人投票，來搶頭香！';
  if (best.allOk) return fmtMD(best.date) + ' 目前全員都可以，領先中！';
  return fmtMD(best.date) + ' 目前 ' + best.voterCount + ' 人可以，領先中！';
}
function dateSectionHtml(data) {
  const marked = {};
  const mineDates = {};
  data.options.dates.forEach(function (o) { if (State.myVotes.has(o.optionId)) mineDates[o.date] = true; });
  data.stats.dates.forEach(function (d) {
    marked[d.date] = { candidate: true, count: d.voterCount, allOk: d.allOk, mine: !!mineDates[d.date] };
  });
  const lead = leadingMessage(data);
  return '<div><span class="section-label yellow">選日期</span>' +
    '<div class="card card-white">' +
    calendarHeaderHtml() +
    calendarHtml(marked, { readonly: false, pickAny: data.votingOpen }) +
    slotPanelHtml(data) +
    calLegendHtml() +
    (lead ? '<div class="cal-news">' + esc(lead) + '</div>' : '') +
    '</div></div>';
}
function slotPanelHtml(data) {
  const d = State.selectedDate;
  if (!d) return '';
  const opts = data.options.dates.filter(function (o) { return o.date === d; });
  if (!opts.length) {
    if (!data.votingOpen) return '';
    return '<div class="slot-panel"><h4>' + fmtMD(d) + '</h4>' +
      '<p class="hint">這天還不是候選日期。覺得這天不錯？</p>' +
      '<button class="btn btn-sm btn-yellow mt8" onclick="App.proposeDate(\'' + d + '\')">＋ 新增這天為候選</button></div>';
  }
  const chips = opts.map(function (o) {
    const on = State.myVotes.has(o.optionId);
    const dis = !data.votingOpen;
    return '<button class="chip slot-toggle' + (on ? ' on' : '') + '" data-oid="' + esc(o.optionId) + '"' +
      (dis ? ' disabled style="opacity:.55;cursor:not-allowed"' : '') + '>' + esc(o.timeSlot) + (on ? ' ✓' : '') + '</button>';
  }).join('');
  const stat = data.stats.dates.find(function (s) { return s.date === d; });
  const voters = stat ? stat.slots.map(function (s) {
    return esc(s.timeSlot) + '：' + (s.voters.length ? s.voters.map(esc).join('、') : '還沒有人');
  }).join('<br>') : '';
  return '<div class="slot-panel"><h4>' + fmtMD(d) + ' 的時段（點選表示你 OK）</h4>' +
    '<div class="chip-row">' + chips + '</div>' +
    '<div class="slot-voters">' + voters + '</div></div>';
}

// ---- 投票頁：地點區 ----
function placeSectionHtml(data) {
  const statsMap = {};
  data.stats.places.forEach(function (s) { statsMap[s.optionId] = s; });
  const cards = data.options.places.map(function (p, i) {
    const s = statsMap[p.optionId] || { count: 0, voters: [] };
    const voted = State.myVotes.has(p.optionId);
    return '<div class="place-card">' +
      '<div class="place-icon c' + (i % 4) + '">' + esc(p.placeName[0] || '地') + '</div>' +
      '<div class="place-info"><div class="place-name">' + esc(p.placeName) + '</div>' +
      (p.mapLink ? '<a class="place-link" href="' + esc(p.mapLink) + '" target="_blank" rel="noopener">Google 地圖 →</a>' : '') +
      '<div class="place-voters">' + (s.count ? s.count + ' 人：' + s.voters.map(esc).join('、') : '還沒有人選') + '</div></div>' +
      '<button class="btn btn-sm place-vote-btn' + (voted ? ' voted' : '') + '" data-oid="' + esc(p.optionId) + '"' +
      (!data.votingOpen ? ' disabled' : '') + '>' + (voted ? '我可以 ✓' : '我可以') + '</button></div>';
  }).join('');
  const addBtn = data.votingOpen
    ? '<div class="text-center mt8"><button class="btn btn-pink" onclick="App.addPlaceModal()">＋ 新增候選地點</button></div>' : '';
  return '<div><span class="section-label mint">選地點</span><div class="card card-white">' +
    (cards || '<div class="empty-state">還沒有候選地點</div>') + addBtn + '</div></div>';
}

// ---- 投票頁：留言區 ----
function commentSectionHtml(data) {
  const canManage = data.me && (data.me.role === 'owner' || data.me.role === 'coadmin');
  const bubbles = data.comments.map(function (c) {
    return '<div class="bubble">' +
      (canManage ? '<button class="bubble-del" data-cid="' + esc(c.commentId) + '" title="刪除留言">✕</button>' : '') +
      '<div class="bubble-head"><span class="bubble-nick">' + esc(c.nickname) + '</span>' +
      (c.optionLabel ? '<span class="bubble-tag">' + esc(c.optionLabel) + '</span>' : '') +
      '<span class="bubble-time">' + fmtDT(c.createdAt) + '</span></div>' +
      '<div class="bubble-content">' + esc(c.content) + '</div></div>';
  }).join('');
  const form = data.votingOpen
    ? '<div class="comment-form">' +
      '<select class="select" id="cmt-option"><option value="">💬 對整場活動留言</option>' + optionSelectOptions(data) + '</select>' +
      '<div class="comment-input-row"><input class="input" id="cmt-input" maxlength="500" placeholder="提個建議吧，例如：這間假日很多人，建議訂位">' +
      '<button class="btn btn-yellow" id="cmt-send">送出</button></div></div>'
    : '<div class="empty-state">投票截止，留言區也休息了。</div>';
  return '<div><span class="section-label pink">留個言</span><div class="card">' +
    (bubbles || '<div class="empty-state">還沒有留言，來說點什麼！</div>') + form + '</div></div>';
}
function optionSelectOptions(data) {
  const dates = data.options.dates.map(function (o) {
    return '<option value="' + esc(o.optionId) + '">📅 ' + fmtMD(o.date) + ' ' + esc(o.timeSlot) + '</option>';
  });
  const places = data.options.places.map(function (o) {
    return '<option value="' + esc(o.optionId) + '">📍 ' + esc(o.placeName) + '</option>';
  });
  return dates.join('') + places.join('');
}
// ---- 投票頁：主渲染與互動 ----
function renderVoteMain(preserve) {
  const data = State.eventData;
  if (!data) return;
  const savedCmt = preserve && $('#cmt-input') ? $('#cmt-input').value : null;
  const savedOpt = preserve && $('#cmt-option') ? $('#cmt-option').value : null;
  let html = '';
  if (data.event.status === 'confirmed') html += resultCardHtml(data);
  html += eventHeaderCardHtml(data) + dateSectionHtml(data) + placeSectionHtml(data) + commentSectionHtml(data);
  $('#view').innerHTML = html;
  document.querySelectorAll('.slot-toggle').forEach(function (btn) {
    btn.onclick = function () { toggleVote(btn.dataset.oid); };
  });
  document.querySelectorAll('.place-vote-btn').forEach(function (btn) {
    btn.onclick = function () { toggleVote(btn.dataset.oid); };
  });
  document.querySelectorAll('.bubble-del').forEach(function (btn) {
    btn.onclick = function () { App.deleteComment(btn.dataset.cid); };
  });
  const send = $('#cmt-send');
  if (send) {
    send.onclick = submitComment;
    $('#cmt-input').onkeydown = function (e) { if (e.key === 'Enter') submitComment(); };
  }
  if (savedCmt !== null && $('#cmt-input')) $('#cmt-input').value = savedCmt;
  if (savedOpt !== null && $('#cmt-option')) $('#cmt-option').value = savedOpt;
}

function ensureCanVote() {
  if (!State.eventData) return false;
  if (!State.eventData.votingOpen) { toast('投票已截止，只能看結果囉', 'err'); return false; }
  if (!State.user) { Auth.requireLogin(); return false; }
  if (!State.eventData.me || !State.eventData.me.nickname) { nicknameModal(); return false; }
  return true;
}

/** 樂觀更新 + 防抖批次送出 */
function toggleVote(optionId) {
  if (!ensureCanVote()) return;
  if (State.myVotes.has(optionId)) State.myVotes.delete(optionId);
  else State.myVotes.add(optionId);
  renderVoteMain(true);
  clearTimeout(State.voteTimer);
  State.voteTimer = setTimeout(async function () {
    try {
      await Data.submitVotes(State.eventId, State.user, Array.from(State.myVotes));
    } catch (e) {
      toast(errMsg(e), 'err');
      forceRefreshEvent(); // 失敗重抓還原
    }
  }, 500);
}

async function submitComment() {
  if (!ensureCanVote()) return;
  const content = $('#cmt-input').value.trim();
  if (!content) { toast('留言不能為空'); return; }
  try {
    await Data.addComment(State.eventId, State.user, $('#cmt-option').value, content);
    const input = $('#cmt-input');
    if (input) input.value = ''; // 先清空，避免重繪時被還原
  } catch (e) { toast(errMsg(e), 'err'); }
}

function proposeDate(dateStr) {
  if (!ensureCanVote()) return;
  const presets = slotPresetsFor(State.eventData.event.types);
  slotPickerModal(dateStr, presets, [], '新增 ' + fmtMD(dateStr) + ' 為候選日期', async function (slots) {
    try {
      for (const s of slots) {
        await Data.addOption(State.eventId, State.user, { optionType: 'date', date: dateStr, timeSlot: s });
      }
      toast('已新增候選日期！', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
  });
}

function ensureHasNickname() {
  if (State.eventData && State.eventData.me && !State.eventData.me.nickname) { nicknameModal(); return false; }
  return true;
}
function addPlaceModal(fromAdmin) {
  if (!fromAdmin && !ensureCanVote()) return;
  if (fromAdmin && !ensureHasNickname()) return;
  openModal(
    '<h3>新增候選地點</h3>' +
    '<div class="field"><label>地點名稱 *</label><input class="input" id="ap-name" maxlength="50" placeholder="例如：深坑老街"></div>' +
    '<div class="field"><label>Google Map 連結（可留空）</label><input class="input" id="ap-link" placeholder="https://maps.google.com/..."></div>' +
    '<div class="modal-actions"><button class="btn btn-white" onclick="App.closeModal()">取消</button>' +
    '<button class="btn btn-mint" id="ap-save">加入</button></div>'
  );
  $('#ap-save').onclick = async function () {
    const name = $('#ap-name').value.trim();
    if (!name) { toast('請填地點名稱', 'err'); return; }
    try {
      const r = await Data.addOption(State.eventId, State.user, {
        optionType: 'place', placeName: name, mapLink: $('#ap-link').value.trim(),
      });
      closeModal();
      toast(r.added ? '已新增地點！' : (r.message || '地點已存在'), r.added ? 'ok' : 'err');
      if (fromAdmin) reloadAdmin();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
}

// ---- 即時同步 / 月份導航 / 日期點選分派 ----
async function forceRefreshEvent() {
  if (!State.eventId) return;
  try {
    const data = await Data.getEventPayload(State.eventId, State.user);
    State.eventData = data;
    State.myVotes = new Set(data.me ? data.me.votes : []);
    const hash = location.hash;
    if (hash.indexOf('/admin') >= 0) return;
    if (hash.indexOf('/results') >= 0) renderResultsMain();
    else renderVoteMain(true);
  } catch (e) { /* 靜默 */ }
}
function startSync() {
  stopSync();
  State.unsubEvent = Data.subscribeEvent(State.eventId, State.user, function (data) {
    State.eventData = data;
    State.myVotes = new Set(data.me ? data.me.votes : []);
    const hash = location.hash;
    if (hash.indexOf('/admin') >= 0) return; // 後台操作期間不打擾
    if (hash.indexOf('/results') >= 0) renderResultsMain();
    else renderVoteMain(true);
  }, function (e) {
    // 活動被刪除、或訂閱本身出錯（例如網路斷線恢復後 SDK 內部狀態卡住）：
    // 停止訂閱並提示使用者重新整理，不要一直靜默掛著一個壞掉的即時同步
    stopSync();
    toast(e && e.message === 'EVENT_NOT_FOUND' ? '這場活動已被刪除' : '連線中斷，請重新整理頁面', 'err');
  });
}
function pickDate(dateStr) {
  if (location.hash.indexOf('#/new') === 0) {
    const taken = NewForm.dateSlots[dateStr] || [];
    slotPickerModal(dateStr, slotPresetsFor(Array.from(NewForm.types)), taken,
      '加入 ' + fmtMD(dateStr) + ' 的時段', function (slots) {
        if (!NewForm.dateSlots[dateStr]) NewForm.dateSlots[dateStr] = [];
        slots.forEach(function (s) {
          if (NewForm.dateSlots[dateStr].indexOf(s) < 0) NewForm.dateSlots[dateStr].push(s);
        });
        renderNewCalendar();
        renderNewPicked();
      });
    return;
  }
  if (!State.eventData) return;
  State.selectedDate = (State.selectedDate === dateStr) ? null : dateStr;
  renderVoteMain(true);
}
// ===================== 結果統計頁 =====================
async function renderResults(eventId) {
  State.eventId = eventId;
  State.selectedDate = null;
  const view = $('#view');
  view.innerHTML = '<div class="loading-card"><div class="loading-star">★</div><p>統計結果計算中…</p></div>';
  try {
    const data = await Data.getEventPayload(eventId, State.user);
    State.eventData = data;
    State.myVotes = new Set(data.me ? data.me.votes : []);
    renderResultsMain();
    startSync();
  } catch (e) {
    view.innerHTML = '<div class="card"><div class="empty-state">😢 ' + esc(errMsg(e)) +
      '<br><br><a class="btn btn-yellow" href="#/">回首頁</a></div></div>';
  }
}

function renderResultsMain() {
  const data = State.eventData;
  if (!data) return;
  const ev = data.event;
  // 月曆熱力圖（唯讀）
  const marked = {};
  data.stats.dates.forEach(function (d) {
    marked[d.date] = { candidate: true, count: d.voterCount, allOk: d.allOk };
  });
  let html = '';
  if (ev.status === 'confirmed') html += resultCardHtml(data);
  html += '<div class="card"><div class="card-title">📊 ' + esc(ev.title) + ' — 結果統計</div>' +
    deadlineBannerHtml(data) +
    '<div class="hint mt8">' + ev.participantCount + ' 人參與・主揪：' + esc(ev.adminNickname) + '</div>' +
    '<div class="gap8 mt8">' +
    '<a class="btn btn-sm btn-yellow" href="#/e/' + esc(ev.eventId) + '">🗳️ 回投票頁</a>' +
    '<button class="btn btn-sm btn-mint" onclick="App.shareCurrent()">📤 分享</button>' +
    '</div></div>';

  // 日期熱力月曆
  html += '<div><span class="section-label yellow">日期熱力圖</span><div class="card card-white">' +
    calendarHeaderHtml() +
    calendarHtml(marked, { readonly: true }) +
    calLegendHtml() +
    (leadingMessage(data) ? '<div class="cal-news">' + esc(leadingMessage(data)) + '</div>' : '') +
    '</div></div>';

  // 日期排行
  const dateRank = data.stats.dates.slice().sort(function (a, b) { return b.voterCount - a.voterCount; });
  const maxD = dateRank.length && dateRank[0].voterCount > 0 ? dateRank[0].voterCount : 1;
  html += '<div><span class="section-label yellow">日期排行</span><div class="card">';
  if (!dateRank.length) html += '<div class="empty-state">沒有候選日期</div>';
  dateRank.forEach(function (d) {
    const slotText = d.slots.map(function (s) { return esc(s.timeSlot) + ' ' + s.count + '人'; }).join('・');
    html += '<div class="rank-row">' +
      '<div style="min-width:64px;font-weight:900">' + (d.allOk ? '★' : '') + fmtMD(d.date) + '</div>' +
      '<div class="rank-bar-wrap"><div class="rank-bar" style="width:' + Math.round(d.voterCount / maxD * 100) + '%"></div></div>' +
      '<div class="rank-num">' + d.voterCount + '</div></div>' +
      '<div class="hint" style="margin:-4px 0 10px 74px">' + slotText + '</div>';
  });
  html += '</div></div>';

  // 地點排行
  const placeRank = data.stats.places.slice().sort(function (a, b) { return b.count - a.count; });
  const maxP = placeRank.length && placeRank[0].count > 0 ? placeRank[0].count : 1;
  const nameOf = {};
  data.options.places.forEach(function (p) { nameOf[p.optionId] = p.placeName; });
  html += '<div><span class="section-label mint">地點排行</span><div class="card">';
  if (!placeRank.length) html += '<div class="empty-state">沒有候選地點</div>';
  placeRank.forEach(function (s, i) {
    html += '<div class="rank-row">' +
      '<div style="min-width:64px;font-weight:900">' + (i === 0 && s.count > 0 ? '🥇 ' : '') + esc(nameOf[s.optionId] || '') + '</div>' +
      '<div class="rank-bar-wrap"><div class="rank-bar" style="width:' + Math.round(s.count / maxP * 100) + '%"></div></div>' +
      '<div class="rank-num">' + s.count + '</div></div>' +
      (s.voters.length ? '<div class="hint" style="margin:-4px 0 10px 74px">' + s.voters.map(esc).join('、') + '</div>' : '');
  });
  html += '</div></div>';

  // 留言列表（唯讀）
  html += '<div><span class="section-label pink">留言回顧</span><div class="card">';
  if (!data.comments.length) html += '<div class="empty-state">沒有留言</div>';
  data.comments.forEach(function (c) {
    html += '<div class="bubble"><div class="bubble-head"><span class="bubble-nick">' + esc(c.nickname) + '</span>' +
      (c.optionLabel ? '<span class="bubble-tag">' + esc(c.optionLabel) + '</span>' : '') +
      '<span class="bubble-time">' + fmtDT(c.createdAt) + '</span></div>' +
      '<div class="bubble-content">' + esc(c.content) + '</div></div>';
  });
  html += '</div></div>';

  $('#view').innerHTML = html;
}
// ===================== 管理後台 =====================
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
async function renderAdmin(eventId) {
  State.eventId = eventId;
  const view = $('#view');
  if (!State.user) {
    view.innerHTML = '<div class="card"><div class="empty-state">管理後台需要登入。</div></div>';
    Auth.requireLogin();
    return;
  }
  view.innerHTML = '<div class="loading-card"><div class="loading-star">★</div><p>後台資料載入中…</p></div>';
  try {
    const data = await Data.getEventPayload(eventId, State.user);
    State.eventData = data;
    const role = data.me ? data.me.role : 'user';
    if (role !== 'owner' && role !== 'coadmin') {
      view.innerHTML = '<div class="card"><div class="empty-state">🚫 只有管理者能進後台喔！' +
        '<br><br><a class="btn btn-yellow" href="#/e/' + esc(eventId) + '">回投票頁</a></div></div>';
      return;
    }
    const detail = await Data.getAdminDetail(eventId);
    renderAdminMain(data, detail);
  } catch (e) {
    view.innerHTML = '<div class="card"><div class="empty-state">😢 ' + esc(errMsg(e)) +
      '<br><br><a class="btn btn-yellow" href="#/e/' + esc(eventId) + '">回投票頁</a></div></div>';
  }
}

function renderAdminMain(data, detail) {
  const ev = data.event;
  const isOwner = data.me.role === 'owner';
  let html = '<div class="card"><div class="card-title">🛠️ ' + esc(ev.title) + ' — 管理後台</div>' +
    deadlineBannerHtml(data) +
    '<div class="gap8 mt8">' +
    '<a class="btn btn-sm btn-yellow" href="#/e/' + esc(ev.eventId) + '">🗳️ 投票頁</a>' +
    '<a class="btn btn-sm btn-white" href="#/e/' + esc(ev.eventId) + '/results">📊 結果頁</a>' +
    '<button class="btn btn-sm btn-mint" onclick="App.shareCurrent()">📤 分享連結</button>' +
    '</div></div>';

  // ---- 參與者明細 ----
  html += '<div class="card admin-section"><h3>👥 參與者明細（' + detail.voterDetails.length + ' 人）</h3>';
  if (!detail.voterDetails.length) {
    html += '<div class="empty-state">還沒有人加入</div>';
  } else {
    html += '<div class="admin-table-wrap"><table class="admin-table"><thead><tr>' +
      '<th>暱稱</th><th>Email</th><th>可參加的日期</th><th>選擇的地點</th><th>最後投票</th>' +
      '</tr></thead><tbody>' +
      detail.voterDetails.map(function (v) {
        return '<tr><td><b>' + esc(v.nickname) + '</b></td><td>' + esc(v.email) + '</td>' +
          '<td>' + (v.dateLabels.map(esc).join('<br>') || '—') + '</td>' +
          '<td>' + (v.placeNames.map(esc).join('<br>') || '—') + '</td>' +
          '<td>' + (fmtDT(v.lastVotedAt) || '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  html += '</div>';

  // ---- 留言管理 ----
  html += '<div class="card admin-section"><h3>💬 留言管理</h3>';
  if (!data.comments.length) html += '<div class="empty-state">沒有留言</div>';
  data.comments.forEach(function (c) {
    html += '<div class="bubble"><button class="bubble-del" data-cid="' + esc(c.commentId) + '" title="刪除留言">✕</button>' +
      '<div class="bubble-head"><span class="bubble-nick">' + esc(c.nickname) + '</span>' +
      (c.optionLabel ? '<span class="bubble-tag">' + esc(c.optionLabel) + '</span>' : '') +
      '<span class="bubble-time">' + fmtDT(c.createdAt) + '</span></div>' +
      '<div class="bubble-content">' + esc(c.content) + '</div></div>';
  });
  html += '</div>';

  // ---- 選項管理 ----
  html += '<div class="card admin-section"><h3>🗂️ 選項管理</h3>';
  html += '<p class="hint mb8">候選日期：</p>';
  html += data.options.dates.length ? '<div class="chip-row mb8">' + data.options.dates.map(function (o) {
    const canDel = isOwner || o.createdByUid !== ev.ownerUid;
    return '<span class="chip" style="cursor:default">' + fmtMD(o.date) + ' ' + esc(o.timeSlot) +
      ' <small style="color:#777">by ' + esc(o.createdBy) + '</small>' +
      (canDel ? ' <b class="opt-del-btn" style="cursor:pointer" data-oid="' + esc(o.optionId) + '">✕</b>' : '') + '</span>';
  }).join('') + '</div>' : '<div class="empty-state">無</div>';
  html += '<p class="hint mb8">候選地點：</p>';
  html += data.options.places.length ? '<div class="chip-row mb8">' + data.options.places.map(function (o) {
    const canDel = isOwner || o.createdByUid !== ev.ownerUid;
    return '<span class="chip" style="cursor:default">' + esc(o.placeName) +
      ' <small style="color:#777">by ' + esc(o.createdBy) + '</small>' +
      (canDel ? ' <b class="opt-del-btn" style="cursor:pointer" data-oid="' + esc(o.optionId) + '">✕</b>' : '') + '</span>';
  }).join('') + '</div>' : '<div class="empty-state">無</div>';
  html += '<div class="gap8"><button class="btn btn-sm btn-yellow" onclick="App.adminAddDate()">＋ 新增日期</button>' +
    '<button class="btn btn-sm btn-mint" onclick="App.addPlaceModal(true)">＋ 新增地點</button></div>';
  html += '</div>';

  html += '<div id="admin-owner-area"></div>';
  $('#view').innerHTML = html;
  document.querySelectorAll('.bubble-del').forEach(function (btn) {
    btn.onclick = function () { App.deleteComment(btn.dataset.cid, true); };
  });
  document.querySelectorAll('.opt-del-btn').forEach(function (btn) {
    btn.onclick = function () { App.adminDeleteOption(btn.dataset.oid); };
  });
  if (isOwner) renderAdminOwnerArea(data, detail);
  else $('#admin-owner-area').innerHTML = '<div class="card"><div class="hint">你是次管理者：可新增選項、刪除留言與查看明細；活動設定、截止時間、最終方案與次管理者由主管理者操作。</div></div>';
}
function renderAdminOwnerArea(data, detail) {
  const ev = data.event;
  let html =
    '<div class="card admin-section"><h3>⚙️ 活動設定</h3>' +
    '<div class="field"><label>活動名稱</label><input class="input" id="adm-title" maxlength="50" value="' + esc(ev.title) + '"></div>' +
    '<div class="field"><label>說明文字</label><textarea class="textarea" id="adm-desc" maxlength="500">' + esc(ev.description) + '</textarea></div>' +
    '<button class="btn btn-sm btn-yellow" onclick="App.saveEventSettings()">儲存設定</button></div>' +

    '<div class="card admin-section"><h3>⏰ 投票截止時間</h3>' +
    '<div class="field"><input class="input" id="adm-deadline" type="datetime-local" value="' + isoToLocalInput(ev.deadline) + '">' +
    '<div class="hint">設為未來時間＝延長或重新開放；清空＝不限時間。</div></div>' +
    '<div class="gap8"><button class="btn btn-sm btn-yellow" onclick="App.setDeadlineAction()">儲存截止時間</button>' +
    (ev.status === 'open' ? '<button class="btn btn-sm btn-pink" onclick="App.closeEventAction()">🔒 立即提前結束投票</button>' : '') +
    '</div></div>' +

    '<div class="card admin-section"><h3>🤝 次管理者</h3>' +
    '<div class="comment-input-row"><input class="input" id="adm-coadmin" type="email" placeholder="輸入對方 Gmail">' +
    '<button class="btn btn-sm btn-mint" onclick="App.addCoAdmin()">加入</button></div>' +
    '<div class="hint">對方用此 Google 帳號登入後，自動取得次管理者權限。</div>' +
    '<div class="chip-row mt8">' +
    (detail.coAdminEmails.length ? detail.coAdminEmails.map(function (e) {
      return '<span class="chip" style="cursor:default">' + esc(e) +
        ' <b class="coadmin-del-btn" style="cursor:pointer" data-email="' + esc(e) + '">✕</b></span>';
    }).join('') : '<span class="hint">尚未指定</span>') + '</div></div>';

  const dateOpts = data.options.dates.map(function (o) {
    return '<option value="' + esc(o.optionId) + '">' + fmtMD(o.date) + ' ' + esc(o.timeSlot) + '</option>';
  }).join('');
  const placeOpts = data.options.places.map(function (o) {
    return '<option value="' + esc(o.optionId) + '">' + esc(o.placeName) + '</option>';
  }).join('');
  html +=
    '<div class="card admin-section"><h3>🎊 標記最終確定方案</h3>' +
    '<div class="field"><label>最終日期</label><select class="select" id="adm-conf-date"><option value="">（不指定）</option>' + dateOpts + '</select></div>' +
    '<div class="field"><label>最終地點</label><select class="select" id="adm-conf-place"><option value="">（不指定）</option>' + placeOpts + '</select></div>' +
    '<button class="btn btn-pink" onclick="App.confirmResultAction()">🎊 確定就是它了！</button>' +
    '<div class="hint mt8">標記後投票正式結束，結果頁會產生可截圖分享的結果卡。</div></div>' +

    '<div class="card admin-section"><h3>📦 匯出結果</h3>' +
    '<button class="btn btn-sm btn-mint" onclick="App.exportCsv()">下載 CSV（含每位參與者明細）</button></div>' +

    '<div class="card admin-section"><h3>⚠️ 危險區</h3>' +
    '<button class="btn btn-danger-outline" onclick="App.deleteEventAction()">刪除整場活動</button>' +
    '<div class="hint mt8">刪除後所有人將無法查看；資料仍保留在資料庫（軟刪除）。</div></div>';
  $('#admin-owner-area').innerHTML = html;
  document.querySelectorAll('.coadmin-del-btn').forEach(function (btn) {
    btn.onclick = function () { App.removeCoAdmin(btn.dataset.email); };
  });
  if (ev.confirmedDateId) $('#adm-conf-date').value = ev.confirmedDateId;
  if (ev.confirmedPlaceId) $('#adm-conf-place').value = ev.confirmedPlaceId;
}
// ---- 後台操作 ----
async function reloadAdmin() { await renderAdmin(State.eventId); }
function adminDeleteOption(optionId) {
  confirmModal('刪除選項', '確定刪除這個選項？已投給它的票會從統計中移除。', '刪除', async function () {
    try { await Data.deleteOption(State.eventId, optionId); toast('已刪除', 'ok'); reloadAdmin(); }
    catch (e) { toast(errMsg(e), 'err'); }
  });
}
function adminAddDate() {
  if (!ensureHasNickname()) return;
  openModal(
    '<h3>新增候選日期</h3>' +
    '<div class="field"><label>日期</label><input class="input" id="aad-date" type="date" min="' + todayStr() + '"></div>' +
    '<div class="field"><label>時段</label><input class="input" id="aad-slot" maxlength="10" placeholder="全天 / 上午 / 下午 / 晚上，或自訂"></div>' +
    '<div class="modal-actions"><button class="btn btn-white" onclick="App.closeModal()">取消</button>' +
    '<button class="btn btn-yellow" id="aad-save">加入</button></div>'
  );
  $('#aad-save').onclick = async function () {
    const d = $('#aad-date').value;
    if (!d) { toast('請選日期', 'err'); return; }
    try {
      await Data.addOption(State.eventId, State.user, { optionType: 'date', date: d, timeSlot: $('#aad-slot').value.trim() || '全天' });
      closeModal(); toast('已新增日期', 'ok'); reloadAdmin();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
}
async function saveEventSettings() {
  try {
    await Data.updateEvent(State.eventId, { title: $('#adm-title').value, description: $('#adm-desc').value });
    toast('設定已儲存', 'ok'); reloadAdmin();
  } catch (e) { toast(errMsg(e), 'err'); }
}
async function setDeadlineAction() {
  const v = $('#adm-deadline').value;
  try {
    await Data.setDeadline(State.eventId, State.eventData.event, v ? new Date(v).toISOString() : '');
    toast('截止時間已更新', 'ok'); reloadAdmin();
  } catch (e) { toast(errMsg(e), 'err'); }
}
function closeEventAction() {
  confirmModal('提前結束投票', '確定現在就截止？之後可再設定未來的截止時間重新開放。', '立即截止', async function () {
    try { await Data.closeEvent(State.eventId); toast('投票已截止', 'ok'); reloadAdmin(); }
    catch (e) { toast(errMsg(e), 'err'); }
  });
}
async function addCoAdmin() {
  const email = $('#adm-coadmin').value.trim();
  if (!email) { toast('請輸入 Email', 'err'); return; }
  try {
    await Data.manageCoAdmins(State.eventId, [email], []);
    toast('已加入次管理者', 'ok'); reloadAdmin();
  } catch (e) { toast(errMsg(e), 'err'); }
}
function removeCoAdmin(email) {
  confirmModal('移除次管理者', '確定移除 ' + email + ' 的次管理者權限？', '移除', async function () {
    try { await Data.manageCoAdmins(State.eventId, [], [email]); toast('已移除', 'ok'); reloadAdmin(); }
    catch (e) { toast(errMsg(e), 'err'); }
  });
}
function confirmResultAction() {
  const dateId = $('#adm-conf-date').value, placeId = $('#adm-conf-place').value;
  if (!dateId && !placeId) { toast('請至少選一項', 'err'); return; }
  confirmModal('標記最終方案', '確定後投票將正式結束，並產生結果卡。要繼續嗎？', '🎊 確定！', async function () {
    try {
      await Data.confirmResult(State.eventId, dateId, placeId);
      toast('已標記最終方案！', 'ok');
      location.hash = '#/e/' + State.eventId + '/results';
    } catch (e) { toast(errMsg(e), 'err'); }
  });
}
async function exportCsv() {
  try {
    const r = await Data.exportCsv(State.eventId, State.eventData ? State.eventData.event.title : '');
    const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast('CSV 已下載', 'ok');
  } catch (e) { toast(errMsg(e), 'err'); }
}
function deleteEventAction() {
  confirmModal('刪除整場活動', '確定刪除「' + (State.eventData ? State.eventData.event.title : '') + '」？所有人將無法查看。', '確定刪除', async function () {
    try { await Data.deleteEvent(State.eventId); toast('活動已刪除', 'ok'); location.hash = '#/'; }
    catch (e) { toast(errMsg(e), 'err'); }
  });
}
// ===================== 全域 App（inline onclick 用） =====================
const App = {
  closeModal: closeModal,
  signOut: function () { Auth.signOut(); },
  goNew: function () {
    if (!Auth.requireLogin()) return;
    location.hash = '#/new';
  },
  joinByCode: function () {
    const v = $('#join-code').value.trim().toUpperCase();
    if (!v || v.length < 6) { toast('請輸入完整活動代碼', 'err'); return; }
    location.hash = '#/e/' + v;
  },
  shareCurrent: function () {
    if (State.eventData) shareModal(State.eventData.event.eventId, State.eventData.event.title);
  },
  nicknameModal: nicknameModal,
  pickDate: pickDate,
  removeNewSlot: function (d, s) {
    if (NewForm.dateSlots[d]) {
      NewForm.dateSlots[d] = NewForm.dateSlots[d].filter(function (x) { return x !== s; });
      if (!NewForm.dateSlots[d].length) delete NewForm.dateSlots[d];
      renderNewCalendar();
      renderNewPicked();
    }
  },
  addPlaceRow: function () { addPlaceRow('', ''); },
  proposeDate: proposeDate,
  addPlaceModal: function (fromAdmin) { addPlaceModal(!!fromAdmin); },
  deleteComment: function (cid, fromAdmin) {
    confirmModal('刪除留言', '確定刪除這則留言？刪了就回不來囉。', '刪除', async function () {
      try {
        await Data.deleteComment(State.eventId, cid);
        toast('已刪除留言', 'ok');
        if (fromAdmin) reloadAdmin();
      } catch (e) { toast(errMsg(e), 'err'); }
    });
  },
  adminDeleteOption: adminDeleteOption,
  adminAddDate: adminAddDate,
  saveEventSettings: saveEventSettings,
  setDeadlineAction: setDeadlineAction,
  closeEventAction: closeEventAction,
  addCoAdmin: addCoAdmin,
  removeCoAdmin: removeCoAdmin,
  confirmResultAction: confirmResultAction,
  exportCsv: exportCsv,
  deleteEventAction: deleteEventAction,
};
window.App = App;

// ===================== 啟動 =====================
window.addEventListener('hashchange', route);
window.addEventListener('load', function () {
  Auth.init();
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && State.eventData && location.hash.indexOf('#/e/') === 0 && location.hash.indexOf('/admin') < 0) {
      forceRefreshEvent();
    }
  });
});
