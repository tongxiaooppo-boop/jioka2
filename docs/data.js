/**
 * 揪咖 JioKa2 — Firestore 資料層（取代原本 GAS 版 Code.gs 的 API_HANDLERS）
 * 對外函式名稱與參數盡量比照原本 app.js 呼叫 api(action, params) 的介面，
 * 讓 UI 渲染那一大塊（calendarHtml / renderVoteMain / renderAdminMain...）幾乎不用改。
 */
import { db } from './firebase-init.js';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where,
  onSnapshot, runTransaction, writeBatch, serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
function str(v) { return v === null || v === undefined ? '' : String(v); }
function genId(len) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
const EVENT_ID_LEN = 8;
const EVENT_TYPES = ['一日遊', '聚餐', '聚會'];

function tsToIso(ts) { return ts ? ts.toDate().toISOString() : null; }
function dateInputToTs(v) { return v ? Timestamp.fromDate(new Date(v)) : null; }
function nickKey(nickname) { return String(nickname || '').trim().toLowerCase(); }
function validDateStr(s) { return /^\d{4}-\d{2}-\d{2}$/.test(str(s)); }
/** 只允許 http/https 開頭的連結，擋掉 javascript: 等會在前端被當連結渲染執行的 scheme */
function safeHttpUrl(v) {
  const s = str(v).trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

// ===================== 活動查詢 =====================
export async function getEventPayload(eventId, currentUser) {
  const evRef = doc(db, 'events', eventId);
  const evSnap = await getDoc(evRef);
  if (!evSnap.exists() || evSnap.data().status === 'deleted') fail('EVENT_NOT_FOUND', '找不到這場活動（可能已被刪除）');
  const ev = evSnap.data();

  const [optionsSnap, votesSnap, participantsSnap, commentsSnap] = await Promise.all([
    getDocs(collection(db, 'events', eventId, 'options')),
    getDocs(collection(db, 'events', eventId, 'votes')),
    getDocs(collection(db, 'events', eventId, 'participants')),
    getDocs(collection(db, 'events', eventId, 'comments')),
  ]);

  if (currentUser) await selfRegisterCoAdminIfNeeded(eventId, ev, currentUser);

  return buildPayload(eventId, ev, optionsSnap, votesSnap, participantsSnap, commentsSnap, currentUser);
}

/** 若目前使用者的 Email 在 private/roles 的邀請名單裡、但公開索引 coAdminUids 還沒有他的 uid，幫他補登記一次 */
async function selfRegisterCoAdminIfNeeded(eventId, ev, currentUser) {
  if (ev.ownerUid === currentUser.uid) return;
  if ((ev.coAdminUids || []).indexOf(currentUser.uid) >= 0) return;
  try {
    const rolesSnap = await getDoc(doc(db, 'events', eventId, 'private', 'roles'));
    if (!rolesSnap.exists()) return;
    const emails = rolesSnap.data().coAdminEmails || [];
    if (emails.indexOf(currentUser.email.toLowerCase()) < 0) return;
    await updateDoc(doc(db, 'events', eventId), { coAdminUids: [...(ev.coAdminUids || []), currentUser.uid] });
    ev.coAdminUids = [...(ev.coAdminUids || []), currentUser.uid];
  } catch (e) { /* 不是次管理者，讀不到 roles，忽略即可 */ }
}

function roleOf(ev, currentUser) {
  if (!currentUser) return 'guest';
  if (ev.ownerUid === currentUser.uid) return 'owner';
  if ((ev.coAdminUids || []).indexOf(currentUser.uid) >= 0) return 'coadmin';
  return 'user';
}
function optionLabel(o) {
  if (o.optionType === 'date') {
    const p = str(o.date).split('-');
    return Number(p[1]) + '/' + Number(p[2]) + ' ' + str(o.timeSlot);
  }
  return str(o.placeName);
}
function isVotingOpen(ev) {
  if (ev.status !== 'open') return false;
  if (!ev.deadline) return true;
  return ev.deadline.toMillis() > Date.now();
}

function buildPayload(eventId, ev, optionsSnap, votesSnap, participantsSnap, commentsSnap, currentUser) {
  const participants = participantsSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  const nickOf = {};
  participants.forEach((p) => { nickOf[p.uid] = str(p.nickname); });

  const dateOpts = [], placeOpts = [], optById = {};
  optionsSnap.docs.forEach((d) => {
    const o = d.data();
    if (o.isDeleted) return;
    optById[d.id] = o;
    const item = {
      optionId: d.id, optionType: o.optionType,
      date: str(o.date), timeSlot: str(o.timeSlot),
      placeName: str(o.placeName), mapLink: str(o.mapLink),
      createdBy: nickOf[o.createdByUid] || '早期成員', createdByUid: o.createdByUid,
    };
    if (o.optionType === 'date') dateOpts.push(item); else placeOpts.push(item);
  });
  dateOpts.sort((a, b) => (a.date + a.timeSlot).localeCompare(b.date + b.timeSlot));

  const votesByUid = {};
  votesSnap.docs.forEach((d) => { votesByUid[d.id] = d.data().optionIds || []; });
  const votersByOpt = {};
  Object.keys(votesByUid).forEach((uid) => {
    const nick = nickOf[uid] || '';
    votesByUid[uid].forEach((oid) => {
      if (!optById[oid]) return;
      if (!votersByOpt[oid]) votersByOpt[oid] = [];
      if (votersByOpt[oid].indexOf(nick) < 0) votersByOpt[oid].push(nick);
    });
  });
  const dateAgg = {};
  dateOpts.forEach((o) => {
    if (!dateAgg[o.date]) dateAgg[o.date] = { date: o.date, voterSet: {}, slots: [] };
    const voters = votersByOpt[o.optionId] || [];
    voters.forEach((n) => { dateAgg[o.date].voterSet[n] = true; });
    dateAgg[o.date].slots.push({ optionId: o.optionId, timeSlot: o.timeSlot, count: voters.length, voters });
  });
  const totalP = participants.length;
  const dateStats = Object.keys(dateAgg).sort().map((d) => {
    const g = dateAgg[d];
    const count = Object.keys(g.voterSet).length;
    return { date: d, voterCount: count, allOk: totalP > 0 && count === totalP, slots: g.slots };
  });
  const placeStats = placeOpts.map((o) => {
    const voters = votersByOpt[o.optionId] || [];
    return { optionId: o.optionId, count: voters.length, voters };
  });

  const myUid = currentUser ? currentUser.uid : null;
  const myVotes = myUid ? (votesByUid[myUid] || []).filter((oid) => !!optById[oid]) : [];

  const cmtList = commentsSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((c) => !c.isDeleted)
    .map((c) => ({
      commentId: c.id, optionId: str(c.optionId),
      optionLabel: c.optionId && optById[c.optionId] ? optionLabel(optById[c.optionId]) : '',
      nickname: nickOf[c.uid] || '早期成員', content: str(c.content),
      createdAt: tsToIso(c.createdAt), uid: c.uid,
    }))
    .sort((a, b) => str(a.createdAt).localeCompare(str(b.createdAt)));

  const confD = str(ev.confirmedDateId), confP = str(ev.confirmedPlaceId);
  const role = roleOf(ev, currentUser);
  return {
    votingOpen: isVotingOpen(ev),
    event: {
      eventId, title: str(ev.title),
      types: str(ev.type).split(',').map((s) => s.trim()).filter(Boolean),
      description: str(ev.description), status: str(ev.status),
      deadline: tsToIso(ev.deadline),
      confirmedDateId: confD || null, confirmedPlaceId: confP || null,
      confirmedDateLabel: confD && optById[confD] ? optionLabel(optById[confD]) : '',
      confirmedPlaceName: confP && optById[confP] ? str(optById[confP].placeName) : '',
      confirmedPlaceLink: confP && optById[confP] ? str(optById[confP].mapLink) : '',
      adminNickname: nickOf[ev.ownerUid] || '主揪',
      participantCount: totalP, createdAt: tsToIso(ev.createdAt),
      ownerUid: ev.ownerUid, coAdminUids: ev.coAdminUids || [],
    },
    options: { dates: dateOpts, places: placeOpts },
    stats: { dates: dateStats, places: placeStats },
    comments: cmtList,
    me: currentUser ? {
      uid: myUid, email: currentUser.email, name: currentUser.name,
      nickname: nickOf[myUid] || null, role, votes: myVotes,
    } : null,
  };
}

// ===================== 建立 / 複製活動 =====================
export async function createEvent(user, params) {
  const title = str(params.title).trim();
  if (!title || title.length > 50) fail('BAD_REQUEST', '活動名稱必填（50 字內）');
  const types = (params.types || []).filter((t) => EVENT_TYPES.indexOf(t) >= 0);
  const description = str(params.description).trim().substring(0, 500);
  const dates = params.dates || [], places = params.places || [];
  if (!dates.length && !places.length) fail('BAD_REQUEST', '請至少新增一個候選日期或地點');

  let eventId = genId(EVENT_ID_LEN), tries = 0;
  let evRef = doc(db, 'events', eventId);
  while ((await getDoc(evRef)).exists()) {
    if (++tries > 8) fail('INTERNAL', '產生活動代碼失敗，請再試一次');
    eventId = genId(EVENT_ID_LEN);
    evRef = doc(db, 'events', eventId);
  }

  // 依賴順序：先建活動本體，再建角色/參與者（子集合規則會用 get() 檢查上一步是否已經寫入）
  await setDoc(evRef, {
    title, type: types.join(','), description, status: 'open',
    deadline: dateInputToTs(params.deadline), confirmedDateId: '', confirmedPlaceId: '',
    ownerUid: user.uid, coAdminUids: [], createdAt: serverTimestamp(),
  });
  await setDoc(doc(db, 'events', eventId, 'private', 'roles'), {
    ownerEmail: user.email.toLowerCase(), coAdminEmails: [],
  });
  const nickname = str(user.name).substring(0, 20) || user.email;
  await setDoc(doc(db, 'events', eventId, 'participants', user.uid), {
    nickname, joinedAt: serverTimestamp(), lastVisitAt: serverTimestamp(),
  });
  await setDoc(doc(db, 'events', eventId, 'participantsPrivate', user.uid), { email: user.email.toLowerCase() });
  await setDoc(doc(db, 'events', eventId, 'nicknames', nickKey(nickname)), { uid: user.uid });
  await setDoc(doc(db, 'userJoinedEvents', user.uid, 'items', eventId), { joinedAt: serverTimestamp() });

  const batch = writeBatch(db);
  dates.forEach((d) => {
    if (!validDateStr(d.date)) return;
    const ref = doc(collection(db, 'events', eventId, 'options'));
    batch.set(ref, {
      optionType: 'date', date: str(d.date), timeSlot: str(d.timeSlot).trim().substring(0, 10) || '全天',
      placeName: '', mapLink: '', createdByUid: user.uid, createdAt: serverTimestamp(), isDeleted: false,
    });
  });
  places.forEach((p) => {
    const name = str(p.placeName).trim();
    if (!name) return;
    const ref = doc(collection(db, 'events', eventId, 'options'));
    batch.set(ref, {
      optionType: 'place', date: '', timeSlot: '', placeName: name.substring(0, 50),
      mapLink: safeHttpUrl(p.mapLink).substring(0, 300),
      createdByUid: user.uid, createdAt: serverTimestamp(), isDeleted: false,
    });
  });
  await batch.commit();
  return { eventId };
}

export async function duplicateEvent(user, params) {
  const srcRef = doc(db, 'events', params.sourceEventId);
  const srcSnap = await getDoc(srcRef);
  if (!srcSnap.exists()) fail('EVENT_NOT_FOUND', '找不到原活動');
  const src = srcSnap.data();
  const title = str(params.title).trim() || (str(src.title) + ' 再一攤');
  const placesSnap = await getDocs(collection(db, 'events', params.sourceEventId, 'options'));
  const places = placesSnap.docs
    .map((d) => d.data())
    .filter((o) => o.optionType === 'place' && !o.isDeleted)
    .map((o) => ({ placeName: str(o.placeName), mapLink: str(o.mapLink) }));
  return createEvent(user, {
    title, types: str(src.type).split(',').map((s) => s.trim()).filter(Boolean),
    description: str(src.description), dates: params.dates || [], places, deadline: '',
  });
}

// ===================== 暱稱 =====================
export async function checkNickname(eventId, myUid, nickname) {
  const nickname2 = str(nickname).trim();
  if (!nickname2) return { available: false, reason: '暱稱不能為空' };
  const snap = await getDoc(doc(db, 'events', eventId, 'nicknames', nickKey(nickname2)));
  const taken = snap.exists() && snap.data().uid !== myUid;
  return { available: !taken, reason: taken ? '這個暱稱有人用了，換一個吧' : '' };
}

export async function setNickname(eventId, user, nickname) {
  const nickname2 = str(nickname).trim();
  if (!nickname2 || nickname2.length > 20) fail('BAD_REQUEST', '暱稱必填（20 字內）');
  const newKey = nickKey(nickname2);
  const pRef = doc(db, 'events', eventId, 'participants', user.uid);
  const newNickRef = doc(db, 'events', eventId, 'nicknames', newKey);

  await runTransaction(db, async (tx) => {
    const [pSnap, newNickSnap] = await Promise.all([tx.get(pRef), tx.get(newNickRef)]);
    if (newNickSnap.exists() && newNickSnap.data().uid !== user.uid) fail('NICKNAME_TAKEN', '這個暱稱有人用了，換一個吧');
    const oldNickname = pSnap.exists() ? str(pSnap.data().nickname) : '';
    const oldKey = nickKey(oldNickname);
    if (oldKey && oldKey !== newKey) tx.delete(doc(db, 'events', eventId, 'nicknames', oldKey));
    if (oldKey !== newKey) tx.set(newNickRef, { uid: user.uid });
    tx.set(pRef, {
      nickname: nickname2,
      joinedAt: pSnap.exists() ? pSnap.data().joinedAt : serverTimestamp(),
      lastVisitAt: serverTimestamp(),
    });
  });
  await setDoc(doc(db, 'events', eventId, 'participantsPrivate', user.uid), { email: user.email.toLowerCase() });
  await setDoc(doc(db, 'userJoinedEvents', user.uid, 'items', eventId), { joinedAt: serverTimestamp() }, { merge: true });
  return { nickname: nickname2 };
}

// ===================== 投票 =====================
export async function submitVotes(eventId, user, optionIds) {
  const optionsSnap = await getDocs(collection(db, 'events', eventId, 'options'));
  const validIds = optionsSnap.docs.filter((d) => !d.data().isDeleted).map((d) => d.id);
  // 靜默濾掉已刪除/不存在的選項 id，不整批拒絕（比照原設計，避免選項被刪後使用者被卡住無法改票）
  const ids = (optionIds || []).map(str).filter((oid) => validIds.indexOf(oid) >= 0);
  await setDoc(doc(db, 'events', eventId, 'votes', user.uid), { optionIds: ids, votedAt: serverTimestamp() });
  return { saved: true, count: ids.length };
}

// ===================== 選項 =====================
export async function addOption(eventId, user, params) {
  const optType = str(params.optionType);
  if (optType !== 'date' && optType !== 'place') fail('BAD_REQUEST', 'optionType 需為 date 或 place');
  const optionsSnap = await getDocs(collection(db, 'events', eventId, 'options'));
  const existing = optionsSnap.docs.map((d) => d.data()).filter((o) => !o.isDeleted);
  if (optType === 'date') {
    if (!validDateStr(params.date)) fail('BAD_REQUEST', '日期格式需為 YYYY-MM-DD');
    const slot = str(params.timeSlot).trim().substring(0, 10) || '全天';
    const dup = existing.some((o) => o.optionType === 'date' && o.date === str(params.date) && o.timeSlot === slot);
    if (dup) return { added: false, message: '這個日期時段已存在' };
    await setDoc(doc(collection(db, 'events', eventId, 'options')), {
      optionType: 'date', date: str(params.date), timeSlot: slot, placeName: '', mapLink: '',
      createdByUid: user.uid, createdAt: serverTimestamp(), isDeleted: false,
    });
  } else {
    const name = str(params.placeName).trim();
    if (!name || name.length > 50) fail('BAD_REQUEST', '地點名稱必填（50 字內）');
    const dup = existing.some((o) => o.optionType === 'place' && str(o.placeName).toLowerCase() === name.toLowerCase());
    if (dup) return { added: false, message: '這個地點已存在' };
    await setDoc(doc(collection(db, 'events', eventId, 'options')), {
      optionType: 'place', date: '', timeSlot: '', placeName: name,
      mapLink: safeHttpUrl(params.mapLink).substring(0, 300),
      createdByUid: user.uid, createdAt: serverTimestamp(), isDeleted: false,
    });
  }
  return { added: true };
}

export async function deleteOption(eventId, optionId) {
  await updateDoc(doc(db, 'events', eventId, 'options', optionId), { isDeleted: true });
  return { deleted: true };
}

// ===================== 留言 =====================
export async function addComment(eventId, user, optionId, content) {
  const content2 = str(content).trim();
  if (!content2 || content2.length > 500) fail('BAD_REQUEST', '留言必填（500 字內）');
  await setDoc(doc(collection(db, 'events', eventId, 'comments')), {
    uid: user.uid, optionId: str(optionId), content: content2, createdAt: serverTimestamp(), isDeleted: false,
  });
  await updateDoc(doc(db, 'events', eventId, 'participants', user.uid), { lastVisitAt: serverTimestamp() });
  return { added: true };
}
export async function deleteComment(eventId, commentId) {
  await updateDoc(doc(db, 'events', eventId, 'comments', commentId), { isDeleted: true });
  return { deleted: true };
}

// ===================== 我的揪咖紀錄 =====================
function eventSummary(id, ev, extra) {
  return Object.assign({
    eventId: id, title: str(ev.title), status: str(ev.status),
    deadline: tsToIso(ev.deadline), createdAt: tsToIso(ev.createdAt),
  }, extra || {});
}
export async function listMyEvents(user) {
  const [ownedSnap, coadminSnap, joinedIdxSnap] = await Promise.all([
    getDocs(query(collection(db, 'events'), where('ownerUid', '==', user.uid))),
    getDocs(query(collection(db, 'events'), where('coAdminUids', 'array-contains', user.uid))),
    getDocs(collection(db, 'userJoinedEvents', user.uid, 'items')),
  ]);
  async function withCount(id, ev, extra) {
    const pSnap = await getDocs(collection(db, 'events', id, 'participants'));
    return eventSummary(id, ev, Object.assign({ participantCount: pSnap.size }, extra));
  }
  const owned = (await Promise.all(ownedSnap.docs
    .filter((d) => d.data().status !== 'deleted')
    .map((d) => withCount(d.id, d.data())))).sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)));
  const coadmin = (await Promise.all(coadminSnap.docs
    .filter((d) => d.data().status !== 'deleted')
    .map((d) => withCount(d.id, d.data())))).sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)));

  const joinedIds = joinedIdxSnap.docs.map((d) => d.id);
  const joinedRaw = await Promise.all(joinedIds.map(async (id) => {
    const evSnap = await getDoc(doc(db, 'events', id));
    if (!evSnap.exists() || evSnap.data().status === 'deleted') return null;
    const ev = evSnap.data();
    if (ev.ownerUid === user.uid || (ev.coAdminUids || []).indexOf(user.uid) >= 0) return null; // 已在上面列過
    return withCount(id, ev);
  }));
  const joined = joinedRaw.filter(Boolean).sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)));
  return { owned, coadmin, joined };
}

// ===================== 管理後台 =====================
export async function getAdminDetail(eventId) {
  const [participantsSnap, privateSnap, votesSnap, optionsSnap, rolesSnap] = await Promise.all([
    getDocs(collection(db, 'events', eventId, 'participants')),
    getDocs(collection(db, 'events', eventId, 'participantsPrivate')),
    getDocs(collection(db, 'events', eventId, 'votes')),
    getDocs(collection(db, 'events', eventId, 'options')),
    getDoc(doc(db, 'events', eventId, 'private', 'roles')),
  ]);
  const emailOf = {};
  privateSnap.docs.forEach((d) => { emailOf[d.id] = d.data().email; });
  const optById = {};
  optionsSnap.docs.forEach((d) => { if (!d.data().isDeleted) optById[d.id] = d.data(); });
  const votesByUid = {};
  votesSnap.docs.forEach((d) => { votesByUid[d.id] = d.data(); });

  const voterDetails = participantsSnap.docs.map((d) => {
    const p = d.data();
    const v = votesByUid[d.id];
    const dateLabels = [], placeNames = [];
    (v ? v.optionIds : []).forEach((oid) => {
      const o = optById[oid];
      if (!o) return;
      if (o.optionType === 'date') dateLabels.push(optionLabel(o)); else placeNames.push(str(o.placeName));
    });
    return {
      uid: d.id, email: emailOf[d.id] || '', nickname: str(p.nickname),
      dateLabels, placeNames, joinedAt: tsToIso(p.joinedAt), lastVotedAt: v ? tsToIso(v.votedAt) : '',
    };
  }).sort((a, b) => str(a.joinedAt).localeCompare(str(b.joinedAt)));

  return {
    coAdminEmails: rolesSnap.exists() ? (rolesSnap.data().coAdminEmails || []) : [],
    ownerEmail: rolesSnap.exists() ? rolesSnap.data().ownerEmail : '',
    voterDetails,
  };
}

export async function updateEvent(eventId, patch) {
  const p = {};
  if (patch.title !== undefined) {
    const title = str(patch.title).trim();
    if (!title || title.length > 50) fail('BAD_REQUEST', '活動名稱必填（50 字內）');
    p.title = title;
  }
  if (patch.description !== undefined) p.description = str(patch.description).trim().substring(0, 500);
  if (patch.types !== undefined) p.type = (patch.types || []).filter((t) => EVENT_TYPES.indexOf(t) >= 0).join(',');
  await updateDoc(doc(db, 'events', eventId), p);
  return { updated: true };
}

export async function setDeadline(eventId, ev, deadlineIso) {
  const patch = { deadline: dateInputToTs(deadlineIso) };
  if (ev.status === 'closed' && (!deadlineIso || new Date(deadlineIso).getTime() > Date.now())) patch.status = 'open';
  await updateDoc(doc(db, 'events', eventId), patch);
  return { updated: true, status: patch.status || ev.status };
}
export async function closeEvent(eventId) {
  await updateDoc(doc(db, 'events', eventId), { status: 'closed' });
  return { closed: true };
}
export async function manageCoAdmins(eventId, add, remove) {
  const rolesRef = doc(db, 'events', eventId, 'private', 'roles');
  const rolesSnap = await getDoc(rolesRef);
  const current = rolesSnap.exists() ? (rolesSnap.data().coAdminEmails || []) : [];
  const ownerEmail = rolesSnap.exists() ? rolesSnap.data().ownerEmail : '';
  const currentSet = new Set(current);
  (add || []).forEach((e) => {
    const em = str(e).trim().toLowerCase();
    if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) fail('BAD_REQUEST', 'Email 格式不正確：' + e);
    if (em === ownerEmail) return;
    currentSet.add(em);
  });
  (remove || []).forEach((e) => currentSet.delete(str(e).trim().toLowerCase()));
  const newEmails = Array.from(currentSet);
  await updateDoc(rolesRef, { coAdminEmails: newEmails });
  // coAdminUids（公開索引）同步移除被拔掉的人；新加入者要等對方登入後自我登記（見 selfRegisterCoAdminIfNeeded）
  if ((remove || []).length) {
    const removedEmails = new Set((remove || []).map((e) => str(e).trim().toLowerCase()));
    const privSnap = await getDocs(collection(db, 'events', eventId, 'participantsPrivate'));
    const removedUids = privSnap.docs.filter((d) => removedEmails.has(d.data().email)).map((d) => d.id);
    if (removedUids.length) {
      const evSnap = await getDoc(doc(db, 'events', eventId));
      const keep = (evSnap.data().coAdminUids || []).filter((u) => removedUids.indexOf(u) < 0);
      await updateDoc(doc(db, 'events', eventId), { coAdminUids: keep });
    }
  }
  return { coAdminEmails: newEmails };
}
export async function confirmResult(eventId, dateId, placeId) {
  if (!dateId && !placeId) fail('BAD_REQUEST', '請至少確定日期或地點其中一項');
  await updateDoc(doc(db, 'events', eventId), {
    confirmedDateId: dateId || '', confirmedPlaceId: placeId || '', status: 'confirmed',
  });
  return { confirmed: true };
}
export async function deleteEvent(eventId) {
  await updateDoc(doc(db, 'events', eventId), { status: 'deleted' });
  return { deleted: true };
}

// ===================== 匯出 CSV =====================
function csvCell(v) {
  const s = str(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export async function exportCsv(eventId, eventTitle) {
  const detail = await getAdminDetail(eventId);
  const lines = ['﻿暱稱,Email,可參加的日期時段,選擇的地點,最後投票時間'];
  detail.voterDetails.forEach((v) => {
    lines.push([v.nickname, v.email, v.dateLabels.join('；'), v.placeNames.join('；'), v.lastVotedAt]
      .map(csvCell).join(','));
  });
  return { filename: 'jioka-' + eventId + '.csv', csv: lines.join('\n') };
}

// ===================== 即時同步（取代原本輪詢） =====================
/** 訂閱活動底下所有子集合的變動，debounce 後回呼重新組裝的完整 payload */
export function subscribeEvent(eventId, currentUser, onChange, onError) {
  let timer = null;
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { onChange(await getEventPayload(eventId, currentUser)); }
      catch (e) { if (onError) onError(e); }
    }, 150);
  };
  const unsubs = [
    onSnapshot(doc(db, 'events', eventId), trigger, onError),
    onSnapshot(collection(db, 'events', eventId, 'options'), trigger, onError),
    onSnapshot(collection(db, 'events', eventId, 'votes'), trigger, onError),
    onSnapshot(collection(db, 'events', eventId, 'participants'), trigger, onError),
    onSnapshot(collection(db, 'events', eventId, 'comments'), trigger, onError),
  ];
  return () => unsubs.forEach((u) => u());
}
