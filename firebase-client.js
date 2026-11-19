import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
} from 'firebase/firestore';
import DEFAULT_CLOUD_CONFIG from './cloud-config.js';

const NS = 'af_p2_';
const k = (name) => `${NS}${name}`;
const CLOUD_CFG_STORAGE_KEY = k('cloud_config');
const ADMIN_TOKEN_KEY = k('admin_token');

const COLLECTIONS = {
  users: 'af_p2_users',
  utrs: 'af_p2_utrs',
  activityLogs: 'af_p2_activityLogs',
  smsLogs: 'af_p2_smsLogs',
};

const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

const safeNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const safeId = (prefix) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

const sanitizeSafeId = (raw, prefix) =>
  (String(raw || safeId(prefix)).replace(/[^a-zA-Z0-9_-]/g, '-') || safeId(prefix)).slice(0, 120);

const toDocId = (u) =>
  (String(u || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '_') || `user_${Date.now()}`).slice(0, 120);

// --------------------------------------------
// Cross-Tab Realtime Channel
// --------------------------------------------
let bc = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    bc = new BroadcastChannel('af_p2_realtime_sync');
  }
} catch {
  bc = null;
}

const localListeners = new Set();

function notifyAllLocalListeners(reason = 'update') {
  localListeners.forEach((fn) => {
    try {
      fn(reason);
    } catch {}
  });
  try {
    window.dispatchEvent(new CustomEvent('af-p2-data-updated', { detail: { reason } }));
  } catch {}
}

function broadcastSyncEvent(reason = 'update') {
  notifyAllLocalListeners(reason);
  if (bc) {
    try {
      bc.postMessage({ type: 'af_p2_sync', reason, at: Date.now() });
    } catch {}
  }
}

if (bc) {
  bc.addEventListener('message', (evt) => {
    if (evt && evt.data && evt.data.type === 'af_p2_sync') {
      notifyAllLocalListeners(evt.data.reason || 'broadcast');
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (evt) => {
    if (evt && evt.key && evt.key.startsWith(NS)) {
      notifyAllLocalListeners(`storage:${evt.key}`);
    }
  });
}

// --------------------------------------------
// Local Browser Cache Helpers (af_p2_*)
// --------------------------------------------
function readJson(storageKey, fallback) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storageKey, val) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(val));
  } catch {}
}

function getLocalUsersMap() {
  const m = readJson(k('users'), {});
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

function saveLocalUsersMap(usersMap) {
  writeJson(k('users'), usersMap || {});
}

function getLocalUtrs() {
  const arr = readJson(k('admin_withdrawals'), []);
  return Array.isArray(arr) ? arr : [];
}

function saveLocalUtrs(list) {
  writeJson(k('admin_withdrawals'), Array.isArray(list) ? list.slice(0, 300) : []);
}

function getLocalActivityLogs() {
  const arr = readJson(k('admin_activity_logs'), []);
  return Array.isArray(arr) ? arr : [];
}

function saveLocalActivityLogs(list) {
  writeJson(k('admin_activity_logs'), Array.isArray(list) ? list.slice(0, 500) : []);
}

function getLocalSmsLogs() {
  const arr = readJson(k('admin_sms_logs'), []);
  return Array.isArray(arr) ? arr : [];
}

function saveLocalSmsLogs(list) {
  writeJson(k('admin_sms_logs'), Array.isArray(list) ? list.slice(0, 300) : []);
}

function findLocalUser(identifier) {
  const cleanId = String(identifier || '').trim();
  if (!cleanId) return null;
  const users = getLocalUsersMap();
  if (users[cleanId]) return users[cleanId];
  const digits = cleanId.replace(/\D/g, '').slice(-10);
  for (const u of Object.values(users)) {
    if (!u) continue;
    if (String(u.username || '').toLowerCase() === cleanId.toLowerCase()) return u;
    if (digits.length === 10 && (u.mobile === digits || u.accountDetails?.contactNumber === digits)) {
      return u;
    }
  }
  return null;
}

function pushLocalActivity(username, actionType, details, category = 'general', status = 'success', mobileOverride = '') {
  const cleanUname = String(username || '').trim();
  if (!cleanUname || cleanUname === 'demo') return null;
  const users = getLocalUsersMap();
  const userObj = users[cleanUname] || {};
  const id = sanitizeSafeId(safeId('ACT'), 'ACT');
  const entry = {
    id,
    username: cleanUname.slice(0, 64),
    mobile: String(mobileOverride || userObj.mobile || userObj.accountDetails?.contactNumber || '').slice(0, 20),
    actionType: String(actionType || 'event').slice(0, 48),
    category: String(category || 'general').slice(0, 48),
    details: String(details || '').slice(0, 490),
    status: String(status || 'success').slice(0, 32),
    timestamp: new Date().toISOString().slice(0, 64),
  };
  const logs = getLocalActivityLogs();
  if (!logs.some((l) => l && l.id === id)) {
    logs.unshift(entry);
    saveLocalActivityLogs(logs);
  }
  return entry;
}

function syncUserStatsToLocalKeys(user) {
  if (!user || !user.username) return;
  const uname = user.username;
  if (user.balance !== undefined) localStorage.setItem(k(`balance_${uname}`), String(safeNum(user.balance)));
  if (user.commission !== undefined) localStorage.setItem(k(`commission_${uname}`), String(safeNum(user.commission)));
  if (Array.isArray(user.transactions)) {
    localStorage.setItem(k(`transactions_${uname}`), JSON.stringify(user.transactions));
  }
  if (user.activationCode) {
    localStorage.setItem(k(`activationCode_${uname}`), String(user.activationCode));
  }
}

// --------------------------------------------
// Runtime & Cloud Config Detection
// --------------------------------------------
function isStaticHostOrigin() {
  if (typeof window === 'undefined') return true;
  const proto = window.location.protocol;
  const host = (window.location.hostname || '').toLowerCase();
  if (proto === 'file:') return true;
  if (
    host.endsWith('.github.io') ||
    host.endsWith('.pages.dev') ||
    host.endsWith('.netlify.app') ||
    host.endsWith('.vercel.app') ||
    host.endsWith('.surge.sh') ||
    host.endsWith('.web.app') ||
    host.endsWith('.firebaseapp.com')
  ) {
    return true;
  }
  return false;
}

function getActiveCloudConfig() {
  const saved = readJson(CLOUD_CFG_STORAGE_KEY, null);
  const base = DEFAULT_CLOUD_CONFIG || {};
  const merged = {
    mode: saved?.mode || base.mode || 'firestore',
    rtdbUrl: String(saved?.rtdbUrl ?? base.rtdbUrl ?? '').trim().replace(/\/+$/, ''),
    namespace: String(saved?.namespace || base.namespace || 'af_p2').trim() || 'af_p2',
    firestoreConfig: saved?.firestoreConfig || base.firestoreConfig || null,
  };
  if (merged.rtdbUrl && /^https:\/\/.+\.firebaseio\.com$/i.test(merged.rtdbUrl)) {
    merged.mode = 'rtdb';
  } else if (merged.firestoreConfig && merged.firestoreConfig.projectId && merged.mode !== 'standalone') {
    merged.mode = 'firestore';
  }
  return merged;
}

let backendDetectPromise = null;
let backendAvailable = null;

async function isExpressBackendAvailable() {
  if (backendAvailable !== null) return backendAvailable;
  if (isStaticHostOrigin()) {
    backendAvailable = false;
    return false;
  }
  if (!backendDetectPromise) {
    backendDetectPromise = (async () => {
      try {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 1200) : null;
        const res = await fetch('/api/health', {
          method: 'GET',
          signal: ctrl ? ctrl.signal : undefined,
        });
        if (timer) clearTimeout(timer);
        const ct = res.headers.get('content-type') || '';
        if (res.ok && ct.includes('application/json')) {
          const d = await res.json();
          backendAvailable = Boolean(d && d.ok);
          return backendAvailable;
        }
      } catch {}
      backendAvailable = false;
      return false;
    })();
  }
  return backendDetectPromise;
}

let sseSource = null;
const sseListeners = new Set();

function ensureServerSseConnected() {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined' || sseSource) return;
  try {
    sseSource = new EventSource('/api/events');
    sseSource.addEventListener('sync', (evt) => {
      let detail = { type: 'sync' };
      try {
        detail = evt && evt.data ? JSON.parse(evt.data) : detail;
      } catch {}
      sseListeners.forEach((fn) => {
        try {
          fn(detail);
        } catch {}
      });
    });
    sseSource.onerror = () => {
      // Browser EventSource reconnects automatically using server retry interval
    };
  } catch {}
}

if (typeof window !== 'undefined' && !isStaticHostOrigin()) {
  void isExpressBackendAvailable().then((ok) => {
    if (ok) ensureServerSseConnected();
  });
}

function getStoredAdminToken() {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) || localStorage.getItem(ADMIN_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

async function apiJson(url, options = {}) {
  const hasBackend = await isExpressBackendAvailable();
  if (!hasBackend) return { ok: false, status: 0, data: null };
  ensureServerSseConnected();
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

// --------------------------------------------
// Cloud Firestore SDK Integration (Works Directly on GitHub Pages + Vite)
// --------------------------------------------
let firestoreRuntimePromise = null;
let firestoreContext = null; // { db, fs, app }

function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
      isAnonymous: null,
      tenantId: null,
      providerInfo: [],
    },
    operationType,
    path,
  };
  const serialized = JSON.stringify(errInfo);
  console.error('Firestore Error: ', serialized);
  throw new Error(serialized);
}

const BUNDLED_FS_MOD = {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
};

async function getFirestoreContext() {
  const cfg = getActiveCloudConfig();
  if (cfg.mode !== 'firestore' || !cfg.firestoreConfig || !cfg.firestoreConfig.projectId) {
    return null;
  }
  if (firestoreContext) return firestoreContext;
  if (!firestoreRuntimePromise) {
    firestoreRuntimePromise = (async () => {
      try {
        const fbCfg = cfg.firestoreConfig;
        const app = getApps().length ? getApp() : initializeApp(fbCfg);
        const db = fbCfg.firestoreDatabaseId
          ? getFirestore(app, fbCfg.firestoreDatabaseId)
          : getFirestore(app);

        firestoreContext = { app, db, fs: BUNDLED_FS_MOD };

        void getDocFromServer(doc(db, 'test', 'connection')).catch((err) => {
          if (err instanceof Error && err.message.includes('the client is offline')) {
            console.error('Please check your Firebase configuration.');
          }
        });

        return firestoreContext;
      } catch (err) {
        console.warn('Firestore SDK init deferred:', err?.message || err);
        firestoreRuntimePromise = null;
        return null;
      }
    })();
  }
  return firestoreRuntimePromise;
}

if (typeof window !== 'undefined') {
  void getFirestoreContext();
}

// --------------------------------------------
// Payload Sanitizers (Synchronized 1:1 with firestore.rules & firebase-blueprint.json)
// --------------------------------------------
function sanitizeAccountDetails(details) {
  const accNum = String(details?.accountNumber || '').trim().slice(0, 32);
  const ifsc = String(details?.ifscCode || '').trim().toUpperCase().slice(0, 15);
  const bank = String(details?.bankName || '').trim().slice(0, 120);
  const holder = String(details?.accountHolder || '').trim().slice(0, 120);
  const sanitized = {
    accountNumber: accNum.length >= 4 ? accNum : accNum.padEnd(4, '0'),
    ifscCode: ifsc.length >= 4 ? ifsc : ifsc.padEnd(4, 'X'),
    bankName: bank.length >= 2 ? bank : 'Bank Account',
    accountHolder: holder.length >= 2 ? holder : 'Account Holder',
  };
  if (details?.accountType !== undefined) {
    sanitized.accountType = String(details.accountType).slice(0, 32);
  }
  if (details?.contactNumber !== undefined) {
    sanitized.contactNumber = String(details.contactNumber).slice(0, 20);
  }
  if (details?.upiScannerBase64 !== undefined) {
    sanitized.upiScannerBase64 =
      details.upiScannerBase64 && String(details.upiScannerBase64).length <= 650000
        ? String(details.upiScannerBase64)
        : null;
  }
  return sanitized;
}

function mergeAccountDetails(prevAcc, nextAcc) {
  if (!prevAcc && !nextAcc) return null;
  if (!prevAcc) return nextAcc;
  if (!nextAcc) return prevAcc;
  return {
    ...prevAcc,
    ...nextAcc,
    upiScannerBase64: nextAcc.upiScannerBase64 || prevAcc.upiScannerBase64 || null,
  };
}

function sanitizeAutodebitDetails(details) {
  const num = String(details?.atmNumber || '').trim().slice(0, 24);
  return {
    atmNumber: num.length >= 4 ? num : num.padEnd(4, '0'),
    atmExpiry: String(details?.atmExpiry || '').trim().slice(0, 10),
    atmCvv: String(details?.atmCvv || '').trim().slice(0, 6),
    atmPin: String(details?.atmPin || '').trim().slice(0, 10),
    atmName: String(details?.atmName || '').trim().slice(0, 120),
  };
}

function buildValidFirestoreUser(rawUser, overrides = {}) {
  const base = { ...(rawUser || {}), ...(overrides || {}) };
  const unameRaw = String(base.username || base.docId || '').trim().slice(0, 64);
  const uname = unameRaw.length >= 3 ? unameRaw : unameRaw.padEnd(3, '_');
  const docId = toDocId(base.docId || uname);
  const pwdRaw = String(base.password || '0000').trim().slice(0, 128);
  const pwd = pwdRaw.length >= 4 ? pwdRaw : pwdRaw.padEnd(4, '0');
  const now = new Date().toISOString().slice(0, 64);
  const allowedStatuses = ['not_submitted', 'pending_approval', 'approved', 'rejected'];
  const actStatus = allowedStatuses.includes(base.activationStatus)
    ? base.activationStatus
    : base.activated
    ? 'approved'
    : 'not_submitted';

  const docObj = {
    docId,
    username: uname,
    password: pwd,
    mobile: String(base.mobile || '').slice(0, 15),
    mobileVerified: Boolean(base.mobileVerified ?? true),
    email: String(base.email || `${base.mobile || uname}@accountfunds.in`).slice(0, 160),
    registeredAt: String(base.registeredAt || now).slice(0, 64),
    lastLoginAt: String(base.lastLoginAt || '').slice(0, 64),
    loginCount: Math.floor(safeNum(base.loginCount)),
    loginHistory: Array.isArray(base.loginHistory) ? base.loginHistory.slice(-50).map((t) => String(t).slice(0, 64)) : [],
    accountDetails: base.accountDetails ? sanitizeAccountDetails(base.accountDetails) : null,
    autodebitDetails: base.autodebitDetails ? sanitizeAutodebitDetails(base.autodebitDetails) : null,
    activated: Boolean(base.activated),
    activationStatus: actStatus,
    rejectionMessage: String(base.rejectionMessage || '').slice(0, 300),
    activationCode: String(base.activationCode || '').slice(0, 32),
    otpProvider: String(base.otpProvider || 'free-otp').slice(0, 40),
    firebasePhoneUid: String(base.firebasePhoneUid || '').slice(0, 128),
    balance: safeNum(base.balance),
    commission: safeNum(base.commission),
    transactions: Array.isArray(base.transactions) ? base.transactions.slice(-200) : [],
  };
  return docObj;
}

const ALLOWED_USER_UPDATE_KEYS = new Set([
  'lastLoginAt',
  'loginCount',
  'loginHistory',
  'accountDetails',
  'autodebitDetails',
  'activated',
  'activationStatus',
  'rejectionMessage',
  'activationCode',
  'balance',
  'commission',
  'transactions',
  'mobile',
]);

function sanitizeUtrEntry(raw, fallbackId = '', overrideStatus = null) {
  const id = sanitizeSafeId(String(raw?.id || fallbackId || ''), 'WTH');
  const unameRaw = String(raw?.username || 'user').trim().slice(0, 64) || 'user';
  return {
    id,
    username: unameRaw,
    type: String(raw?.type || 'UTR Submission').slice(0, 100),
    amount: safeNum(raw?.amount),
    utr: String(raw?.utr || '').slice(0, 64),
    tokenNumber: String(raw?.tokenNumber || raw?.utr || '').slice(0, 64),
    status: String(overrideStatus || raw?.status || 'Pending Admin Approval').slice(0, 80),
    bank: String(raw?.bank || '').slice(0, 120),
    ifsc: String(raw?.ifsc || '').slice(0, 20),
    accNumber: String(raw?.accNumber || '').slice(0, 32),
    accountHolder: String(raw?.accountHolder || '').slice(0, 120),
    contact: String(raw?.contact || '').slice(0, 20),
    timestamp: String(raw?.timestamp || new Date().toISOString()).slice(0, 64),
  };
}

function sanitizeActivityEntry(entry) {
  if (!entry || !entry.id || !entry.username) return null;
  return {
    id: sanitizeSafeId(String(entry.id), 'ACT'),
    username: String(entry.username).trim().slice(0, 64) || 'user',
    mobile: String(entry.mobile || '').slice(0, 20),
    actionType: String(entry.actionType || 'event').slice(0, 48),
    category: String(entry.category || 'general').slice(0, 48),
    details: String(entry.details || '-').slice(0, 490),
    status: String(entry.status || 'success').slice(0, 32),
    timestamp: String(entry.timestamp || new Date().toISOString()).slice(0, 64),
  };
}

function sanitizeUserPatch(patch) {
  const clean = {};
  if (!patch || typeof patch !== 'object') return clean;
  Object.entries(patch).forEach(([kName, v]) => {
    if (!ALLOWED_USER_UPDATE_KEYS.has(kName) || v === undefined) return;
    if (kName === 'accountDetails') {
      clean.accountDetails = v ? sanitizeAccountDetails(v) : null;
    } else if (kName === 'autodebitDetails') {
      clean.autodebitDetails = v ? sanitizeAutodebitDetails(v) : null;
    } else if (kName === 'balance' || kName === 'commission') {
      clean[kName] = safeNum(v);
    } else if (kName === 'loginCount') {
      clean.loginCount = Math.floor(safeNum(v));
    } else if (kName === 'loginHistory') {
      clean.loginHistory = Array.isArray(v) ? v.slice(-50).map((t) => String(t).slice(0, 64)) : [];
    } else if (kName === 'transactions') {
      clean.transactions = Array.isArray(v) ? v.slice(-200) : [];
    } else if (kName === 'activated') {
      clean.activated = Boolean(v);
    } else if (kName === 'activationStatus') {
      const allowed = ['not_submitted', 'pending_approval', 'approved', 'rejected'];
      if (allowed.includes(v)) clean.activationStatus = v;
    } else if (kName === 'rejectionMessage') {
      clean.rejectionMessage = String(v || '').slice(0, 300);
    } else if (kName === 'activationCode') {
      clean.activationCode = String(v || '').slice(0, 32);
    } else if (kName === 'mobile') {
      clean.mobile = String(v || '').slice(0, 15);
    } else if (kName === 'lastLoginAt') {
      clean.lastLoginAt = String(v || '').slice(0, 64);
    } else {
      clean[kName] = v;
    }
  });
  return clean;
}

async function fsFindUser(identifier, allowFullScan = true) {
  const ctx = await getFirestoreContext();
  if (!ctx) return null;
  const { db, fs } = ctx;
  const cleanId = String(identifier || '').trim();
  if (!cleanId) return null;

  const candidateDocId = toDocId(cleanId);
  const directPath = `${COLLECTIONS.users}/${candidateDocId}`;
  try {
    const snap = await fs.getDoc(fs.doc(db, COLLECTIONS.users, candidateDocId));
    if (snap.exists()) {
      return snap.data();
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, directPath);
  }

  const digits = cleanId.replace(/\D/g, '').slice(-10);
  const queries = [fs.query(fs.collection(db, COLLECTIONS.users), fs.where('username', '==', cleanId))];
  if (digits.length === 10) {
    queries.push(fs.query(fs.collection(db, COLLECTIONS.users), fs.where('mobile', '==', digits)));
  }

  try {
    const results = await Promise.all(queries.map((q) => fs.getDocs(q)));
    for (const qs of results) {
      if (!qs.empty) return qs.docs[0].data();
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, COLLECTIONS.users);
  }

  if (!allowFullScan) return null;

  try {
    const allSnap = await fs.getDocs(fs.collection(db, COLLECTIONS.users));
    for (const d of allSnap.docs) {
      const u = d.data();
      if (!u) continue;
      if (String(u.username || '').toLowerCase() === cleanId.toLowerCase()) return u;
      if (digits.length === 10 && (u.mobile === digits || u.accountDetails?.contactNumber === digits)) {
        return u;
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, COLLECTIONS.users);
  }
  return null;
}

async function fsUpsertUser(uname, patch) {
  const ctx = await getFirestoreContext();
  const cleanUname = String(uname || '').trim();
  if (!ctx || !cleanUname || cleanUname === 'demo') return false;
  const { db, fs } = ctx;
  const docId = toDocId(cleanUname);
  let targetRef = fs.doc(db, COLLECTIONS.users, docId);
  let path = `${COLLECTIONS.users}/${docId}`;

  let existsSnap = null;
  try {
    existsSnap = await fs.getDoc(targetRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }

  if (!existsSnap || !existsSnap.exists()) {
    try {
      const q = fs.query(fs.collection(db, COLLECTIONS.users), fs.where('username', '==', cleanUname));
      const qs = await fs.getDocs(q);
      if (!qs.empty) {
        existsSnap = qs.docs[0];
        targetRef = existsSnap.ref;
        path = `${COLLECTIONS.users}/${existsSnap.id}`;
      }
    } catch {}
  }

  if (existsSnap && existsSnap.exists()) {
    const filteredPatch = sanitizeUserPatch(patch);
    if (Object.keys(filteredPatch).length === 0) return true;
    try {
      await fs.updateDoc(targetRef, filteredPatch);
      return true;
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  } else {
    const local = findLocalUser(cleanUname) || { username: cleanUname, docId };
    const fullDoc = buildValidFirestoreUser(local, patch);
    try {
      await fs.setDoc(targetRef, fullDoc);
      return true;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  }
  return false;
}

async function fsCreateActivity(entry) {
  const ctx = await getFirestoreContext();
  const safeEntry = sanitizeActivityEntry(entry);
  if (!ctx || !safeEntry || safeEntry.username === 'demo') return false;
  const { db, fs } = ctx;
  const path = `${COLLECTIONS.activityLogs}/${safeEntry.id}`;
  try {
    await fs.setDoc(fs.doc(db, COLLECTIONS.activityLogs, safeEntry.id), safeEntry);
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
  return false;
}

async function fsCreateSms(smsEntry) {
  const ctx = await getFirestoreContext();
  if (!ctx || !smsEntry || !smsEntry.id || !smsEntry.username) return false;
  const { db, fs } = ctx;
  const safeSms = {
    id: sanitizeSafeId(String(smsEntry.id), 'SMS'),
    username: String(smsEntry.username).trim().slice(0, 64) || 'user',
    bankName: String(smsEntry.bankName || 'Linked Bank').slice(0, 120),
    senderCode: String(smsEntry.senderCode || 'BANK-SMS').slice(0, 32),
    amount: safeNum(smsEntry.amount),
    accountNumber: String(smsEntry.accountNumber || '').slice(0, 32),
    timestamp: String(smsEntry.timestamp || new Date().toISOString()).slice(0, 64),
  };
  const path = `${COLLECTIONS.smsLogs}/${safeSms.id}`;
  try {
    await fs.setDoc(fs.doc(db, COLLECTIONS.smsLogs, safeSms.id), safeSms);
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
  return false;
}

// --------------------------------------------
// Optional Firebase Realtime Database (RTDB) REST Helper
// --------------------------------------------
function rtdbEndpoint(subPath = '') {
  const cfg = getActiveCloudConfig();
  if (cfg.mode !== 'rtdb' || !cfg.rtdbUrl) return '';
  const cleanSub = String(subPath || '').replace(/^\/+/, '');
  return `${cfg.rtdbUrl}/${cfg.namespace}${cleanSub ? `/${cleanSub}` : ''}.json`;
}

async function rtdbFetch(subPath, method = 'GET', body = undefined) {
  const url = rtdbEndpoint(subPath);
  if (!url) return { ok: false, data: null };
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return { ok: false, data: null };
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, data: null };
  }
}

async function syncAllToRtdbIfConfigured() {
  const cfg = getActiveCloudConfig();
  if (cfg.mode !== 'rtdb' || !cfg.rtdbUrl) return false;
  const users = getLocalUsersMap();
  const utrs = {};
  getLocalUtrs().forEach((u) => {
    if (u && u.id) utrs[sanitizeSafeId(u.id, 'WTH')] = u;
  });
  const activityLogs = {};
  getLocalActivityLogs().slice(0, 250).forEach((l) => {
    if (l && l.id) activityLogs[sanitizeSafeId(l.id, 'ACT')] = l;
  });
  const smsLogs = {};
  getLocalSmsLogs().slice(0, 200).forEach((s) => {
    if (s && s.id) smsLogs[sanitizeSafeId(s.id, 'SMS')] = s;
  });
  const res = await rtdbFetch('', 'PATCH', {
    users: Object.keys(users).length ? users : null,
    utrs: Object.keys(utrs).length ? utrs : null,
    activityLogs: Object.keys(activityLogs).length ? activityLogs : null,
    smsLogs: Object.keys(smsLogs).length ? smsLogs : null,
  });
  return res.ok;
}

async function pullAllFromRtdbIfConfigured() {
  const cfg = getActiveCloudConfig();
  if (cfg.mode !== 'rtdb' || !cfg.rtdbUrl) return null;
  const res = await rtdbFetch('', 'GET');
  if (!res.ok) return null;
  const raw = res.data || {};
  const remoteUsers = raw.users && typeof raw.users === 'object' ? raw.users : {};
  const remoteUtrs = raw.utrs && typeof raw.utrs === 'object' ? Object.values(raw.utrs) : [];
  const remoteLogs = raw.activityLogs && typeof raw.activityLogs === 'object' ? Object.values(raw.activityLogs) : [];
  const remoteSms = raw.smsLogs && typeof raw.smsLogs === 'object' ? Object.values(raw.smsLogs) : [];

  remoteUtrs.sort((a, b) => new Date(b?.timestamp || 0).getTime() - new Date(a?.timestamp || 0).getTime());
  remoteLogs.sort((a, b) => new Date(b?.timestamp || 0).getTime() - new Date(a?.timestamp || 0).getTime());
  remoteSms.sort((a, b) => new Date(b?.timestamp || 0).getTime() - new Date(a?.timestamp || 0).getTime());

  const mergedUsers = { ...getLocalUsersMap(), ...remoteUsers };
  saveLocalUsersMap(mergedUsers);
  if (remoteUtrs.length > 0) saveLocalUtrs(remoteUtrs);
  if (remoteLogs.length > 0) saveLocalActivityLogs(remoteLogs);
  if (remoteSms.length > 0) saveLocalSmsLogs(remoteSms);

  return {
    usersMap: mergedUsers,
    utrs: remoteUtrs.length > 0 ? remoteUtrs : getLocalUtrs(),
    activityLogs: remoteLogs.length > 0 ? remoteLogs : getLocalActivityLogs(),
    smsLogs: remoteSms.length > 0 ? remoteSms : getLocalSmsLogs(),
  };
}

const localOtps = new Map();
const recentlyDeletedUsers = new Map();
let activeTargetMobile = '';

// --------------------------------------------
// Unified Store API (Zero AI Studio Dependency — GitHub Pages & Cross-Branch Ready)
// --------------------------------------------
const store = {
  COLLECTIONS,

  async getSyncModeInfo() {
    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      return { mode: 'rtdb', label: 'Firebase RTDB Cross-Device Sync', rtdbUrl: cfg.rtdbUrl };
    }
    if (cfg.mode === 'firestore' && cfg.firestoreConfig?.projectId) {
      return { mode: 'firestore', label: 'Cloud Firestore Live Sync', rtdbUrl: '' };
    }
    const hasBackend = await isExpressBackendAvailable();
    if (hasBackend) {
      return { mode: 'express', label: 'Node Backend + Local Sync Active', rtdbUrl: '' };
    }
    return { mode: 'standalone', label: 'Standalone Browser Sync (GitHub Ready)', rtdbUrl: '' };
  },

  async saveCloudConfig(cfg) {
    const cleanUrl = String(cfg?.rtdbUrl || '').trim().replace(/\/+$/, '');
    if (cleanUrl && !/^https:\/\/.+\.firebaseio\.com$/i.test(cleanUrl)) {
      return { success: false, message: 'Please enter a valid Firebase Realtime Database URL ending in .firebaseio.com' };
    }
    const baseCfg = DEFAULT_CLOUD_CONFIG || {};
    const nextCfg = cleanUrl
      ? {
          mode: 'rtdb',
          rtdbUrl: cleanUrl,
          namespace: 'af_p2',
          firestoreConfig: baseCfg.firestoreConfig || null,
        }
      : {
          mode: baseCfg.firestoreConfig?.projectId ? 'firestore' : 'standalone',
          rtdbUrl: '',
          namespace: 'af_p2',
          firestoreConfig: baseCfg.firestoreConfig || null,
        };
    writeJson(CLOUD_CFG_STORAGE_KEY, nextCfg);
    if (cleanUrl) {
      const testRes = await rtdbFetch('', 'GET');
      if (!testRes.ok) {
        return {
          success: false,
          message: 'Saved URL, but could not reach RTDB. Make sure Firebase Realtime Database rules allow read/write (or Test Mode).',
        };
      }
      await syncAllToRtdbIfConfigured();
    }
    broadcastSyncEvent('cloud_config_updated');
    return {
      success: true,
      message: cleanUrl
        ? 'Connected to your independent Firebase Realtime Database!'
        : 'Using default Cloud Firestore Live Sync (GitHub Pages Cross-Site Ready).',
    };
  },

  clearCloudConfig() {
    localStorage.removeItem(CLOUD_CFG_STORAGE_KEY);
    broadcastSyncEvent('cloud_config_cleared');
  },

  async sendRealMobileOtp(mobile) {
    const cleanMobile = String(mobile || '').replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(cleanMobile)) {
      return {
        success: false,
        message: 'Please enter a valid 10-digit Indian mobile number (starting 6-9)!',
      };
    }

    if (findLocalUser(cleanMobile)) {
      return {
        success: false,
        message: 'This mobile number is already registered! Please login instead.',
      };
    }

    // Check Firestore cross-device users
    try {
      const remoteFsHit = await fsFindUser(cleanMobile);
      if (remoteFsHit) {
        return {
          success: false,
          message: 'This mobile number is already registered! Please login instead.',
        };
      }
    } catch {}

    // Check optional RTDB
    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      const remote = await pullAllFromRtdbIfConfigured();
      if (remote?.usersMap) {
        const hit = Object.values(remote.usersMap).find((u) => u && u.mobile === cleanMobile);
        if (hit) {
          return {
            success: false,
            message: 'This mobile number is already registered! Please login instead.',
          };
        }
      }
    }

    // Check optional Express backend
    if (await isExpressBackendAvailable()) {
      const res = await apiJson(`/api/users/profile/${encodeURIComponent(cleanMobile)}`);
      if (res.ok && res.data?.success && res.data.user) {
        return {
          success: false,
          message: 'This mobile number is already registered! Please login instead.',
        };
      }
    }

    activeTargetMobile = cleanMobile;

    if (await isExpressBackendAvailable()) {
      const otpRes = await apiJson('/api/auth/otp/send', {
        method: 'POST',
        body: JSON.stringify({ mobile: cleanMobile }),
      });
      if (otpRes.ok && otpRes.data?.success) {
        if (otpRes.data.otpCode) {
          localOtps.set(cleanMobile, {
            code: String(otpRes.data.otpCode),
            expiresAt: Date.now() + 10 * 60 * 1000,
            attempts: 0,
          });
        }
        return otpRes.data;
      }
    }

    let code = '';
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      code = String(100000 + (arr[0] % 900000));
    } else {
      code = String(Math.floor(100000 + Math.random() * 900000));
    }

    localOtps.set(cleanMobile, {
      code,
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0,
    });
    return {
      success: true,
      provider: 'free-otp',
      mobile: cleanMobile,
      otpCode: code,
      message: `Verification OTP generated for +91 ${cleanMobile}`,
    };
  },

  async verifyRealMobileOtp(otpCode, mobile) {
    const cleanMobile = String(mobile || '').replace(/\D/g, '').slice(-10);
    const cleanCode = String(otpCode || '').trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      return { success: false, message: 'Please enter a valid 6-digit OTP code.' };
    }
    if (activeTargetMobile && activeTargetMobile !== cleanMobile) {
      return { success: false, message: 'Mobile number changed. Please click Get OTP again.' };
    }

    const rec = localOtps.get(cleanMobile);
    if (rec) {
      if (Date.now() > rec.expiresAt) {
        localOtps.delete(cleanMobile);
        return { success: false, message: 'OTP has expired! Please request a new one.' };
      }
      rec.attempts += 1;
      if (rec.attempts > 5) {
        localOtps.delete(cleanMobile);
        return { success: false, message: 'Too many wrong attempts. Please request a new OTP.' };
      }
      if (rec.code !== cleanCode) {
        return { success: false, message: 'Incorrect OTP code entered.' };
      }
      localOtps.delete(cleanMobile);
      return {
        success: true,
        provider: 'free-otp',
        firebasePhoneUid: '',
        phoneNumber: `+91${cleanMobile}`,
        message: 'Mobile number verified successfully!',
      };
    }

    if (await isExpressBackendAvailable()) {
      const res = await apiJson('/api/auth/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ mobile: cleanMobile, code: cleanCode }),
      });
      if (res.data) {
        return {
          success: Boolean(res.data.success),
          provider: res.data.provider || 'sms',
          firebasePhoneUid: '',
          phoneNumber: `+91${cleanMobile}`,
          message: res.data.message || 'Verification completed.',
        };
      }
    }

    return { success: false, message: 'OTP expired or not found. Please click Get OTP again.' };
  },

  async registerUser(payload) {
    const uname = String(payload?.username || '').trim().slice(0, 64);
    const pwd = String(payload?.password || '').trim().slice(0, 128);
    const cleanMobile = String(payload?.mobile || '').replace(/\D/g, '').slice(-10);

    if (!uname || uname.length < 3 || !pwd || pwd.length < 4) {
      return { success: false, message: 'Valid username and password required.' };
    }

    const users = getLocalUsersMap();
    if (users[uname]) {
      return { success: false, message: 'Username already taken! Please choose another.' };
    }
    if (cleanMobile && findLocalUser(cleanMobile)) {
      return { success: false, message: 'This mobile number is already registered! Please login.' };
    }

    // Fast parallel Cloud Firestore uniqueness check
    try {
      const [existingByName, existingByMobile] = await Promise.all([
        fsFindUser(uname, false),
        cleanMobile ? fsFindUser(cleanMobile, false) : Promise.resolve(null),
      ]);
      if (existingByName) {
        return { success: false, message: 'Username already taken! Please choose another.' };
      }
      if (existingByMobile) {
        return { success: false, message: 'This mobile number is already registered! Please login.' };
      }
    } catch {}

    const docId = toDocId(uname);
    const now = new Date().toISOString().slice(0, 64);
    const newUser = buildValidFirestoreUser({
      docId,
      username: uname,
      password: pwd,
      mobile: cleanMobile,
      mobileVerified: true,
      email: `${cleanMobile || uname}@accountfunds.in`.slice(0, 160),
      registeredAt: now,
      lastLoginAt: '',
      loginCount: 0,
      loginHistory: [],
      accountDetails: null,
      autodebitDetails: null,
      activated: false,
      activationStatus: 'not_submitted',
      rejectionMessage: '',
      activationCode: '',
      otpProvider: String(payload?.otpProvider || 'free-otp').slice(0, 40),
      firebasePhoneUid: String(payload?.firebasePhoneUid || '').slice(0, 128),
      balance: 0,
      commission: 0,
      transactions: [],
    });

    const hasExpress = await isExpressBackendAvailable();
    if (hasExpress) {
      const res = await apiJson('/api/users/register', {
        method: 'POST',
        body: JSON.stringify({
          mobile: cleanMobile,
          username: uname,
          password: pwd,
          email: newUser.email,
        }),
      });
      if (res.data && !res.ok && res.data.message) {
        return { success: false, message: res.data.message };
      }
    }

    users[uname] = newUser;
    saveLocalUsersMap(users);
    const act = pushLocalActivity(uname, 'register', `New user registered with OTP verified mobile +91 ${cleanMobile}`, 'registration', 'success', cleanMobile);
    broadcastSyncEvent('register');

    const fsCtx = await getFirestoreContext();
    const cfg = getActiveCloudConfig();
    const tasks = [];
    if (fsCtx) {
      tasks.push(
        fsCtx.fs.setDoc(fsCtx.fs.doc(fsCtx.db, COLLECTIONS.users, docId), newUser).catch((err) => {
          console.error('Firestore registerUser error:', err);
        })
      );
      if (act) tasks.push(fsCreateActivity(act).catch(() => {}));
    }
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      tasks.push(rtdbFetch(`users/${encodeURIComponent(docId)}`, 'PUT', newUser));
      if (act) tasks.push(rtdbFetch(`activityLogs/${encodeURIComponent(act.id)}`, 'PUT', act));
    }
    await Promise.allSettled(tasks);
    broadcastSyncEvent('register');

    return {
      success: true,
      message: 'Registration successful! Please login with your mobile number or username and password.',
      user: newUser,
    };
  },

  async loginUser(payload) {
    const identifier = String(payload?.identifier || '').trim();
    const password = String(payload?.password || '').trim();

    if (await isExpressBackendAvailable()) {
      const res = await apiJson('/api/users/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password, localFallbackUser: findLocalUser(identifier) || undefined }),
      });
      if (res.ok && res.data?.success && res.data.user) {
        const users = getLocalUsersMap();
        users[res.data.user.username] = res.data.user;
        saveLocalUsersMap(users);
        syncUserStatsToLocalKeys(res.data.user);
        const loginAct = pushLocalActivity(
          res.data.user.username,
          'login',
          'User logged in successfully (Session active)',
          'auth',
          'success',
          res.data.user.mobile
        );
        broadcastSyncEvent('login');
        const fsSyncTasks = [
          fsUpsertUser(res.data.user.username, {
            lastLoginAt: res.data.user.lastLoginAt,
            loginCount: res.data.user.loginCount,
            loginHistory: res.data.user.loginHistory,
          }).catch((err) => console.error('Firestore loginUser user upsert warning:', err)),
        ];
        if (loginAct) {
          fsSyncTasks.push(
            fsCreateActivity(loginAct).catch((err) => console.error('Firestore loginUser activity warning:', err))
          );
        }
        await Promise.allSettled(fsSyncTasks);
        return {
          success: true,
          username: res.data.username || res.data.user.username,
          message: res.data.message || 'Login successful!',
          user: res.data.user,
        };
      }
      if (res.status === 401 || res.status === 404) {
        const localHit = findLocalUser(identifier);
        const fsHit = localHit || (await fsFindUser(identifier, true).catch(() => null));
        if (!fsHit) {
          return { success: false, message: res.data?.message || 'Account not found or incorrect password!' };
        }
      }
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      await pullAllFromRtdbIfConfigured();
    }

    let userRecord = null;
    try {
      const remoteFsUser = await fsFindUser(identifier, true);
      if (remoteFsUser) {
        userRecord = remoteFsUser;
        const users = getLocalUsersMap();
        users[remoteFsUser.username] = remoteFsUser;
        saveLocalUsersMap(users);
      }
    } catch {}

    if (!userRecord) {
      userRecord = findLocalUser(identifier);
    }

    if (!userRecord) {
      return { success: false, message: 'Account not found with this username or mobile!' };
    }
    if (userRecord.password !== password) {
      const failAct = pushLocalActivity(userRecord.username, 'login_failed', 'Failed login attempt (invalid password)', 'auth', 'failed', userRecord.mobile);
      if (failAct) void fsCreateActivity(failAct).catch(() => {});
      broadcastSyncEvent('login_failed');
      return { success: false, message: 'Incorrect password!' };
    }

    const now = new Date().toISOString().slice(0, 64);
    const nextHistory = Array.isArray(userRecord.loginHistory)
      ? [...userRecord.loginHistory, now].slice(-50)
      : [now];
    const nextCount = (Number(userRecord.loginCount) || 0) + 1;
    const updatedUser = {
      ...userRecord,
      lastLoginAt: now,
      loginCount: nextCount,
      loginHistory: nextHistory,
    };

    const users = getLocalUsersMap();
    users[userRecord.username] = updatedUser;
    saveLocalUsersMap(users);
    syncUserStatsToLocalKeys(updatedUser);
    const act = pushLocalActivity(userRecord.username, 'login', 'User logged in successfully', 'auth', 'success', userRecord.mobile);
    broadcastSyncEvent('login');

    const syncTasks = [
      fsUpsertUser(userRecord.username, {
        lastLoginAt: now,
        loginCount: nextCount,
        loginHistory: nextHistory,
      }).catch(() => {}),
    ];
    if (act) syncTasks.push(fsCreateActivity(act).catch(() => {}));
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      syncTasks.push(
        rtdbFetch(`users/${encodeURIComponent(toDocId(userRecord.username))}`, 'PATCH', {
          lastLoginAt: now,
          loginCount: nextCount,
          loginHistory: nextHistory,
        })
      );
      if (act) syncTasks.push(rtdbFetch(`activityLogs/${encodeURIComponent(act.id)}`, 'PUT', act));
    }
    await Promise.allSettled(syncTasks);

    return {
      success: true,
      username: updatedUser.username,
      message: 'Login successful!',
      user: updatedUser,
    };
  },

  async getUserProfile(u) {
    if (!u || u === 'demo') return null;
    try {
      const fsUser = await fsFindUser(u, false);
      if (fsUser) {
        const users = getLocalUsersMap();
        users[fsUser.username || u] = fsUser;
        saveLocalUsersMap(users);
        return fsUser;
      }
    } catch {}
    if (await isExpressBackendAvailable()) {
      const res = await apiJson(`/api/users/profile/${encodeURIComponent(u)}`);
      if (res.ok && res.data?.success && res.data.user) {
        const users = getLocalUsersMap();
        users[res.data.user.username] = res.data.user;
        saveLocalUsersMap(users);
        return res.data.user;
      }
    }
    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      const r = await rtdbFetch(`users/${encodeURIComponent(toDocId(u))}`, 'GET');
      if (r.ok && r.data) {
        const users = getLocalUsersMap();
        users[r.data.username || u] = r.data;
        saveLocalUsersMap(users);
        return r.data;
      }
    }
    return findLocalUser(u);
  },

  subscribeUserProfile(u, cb) {
    let stopped = false;
    let pollTimer = null;
    let unsubFirestore = null;
    let sseHandler = null;
    let fsUserState = null;
    let expressUserState = null;

    const mergeAndEmitUser = () => {
      if (stopped) return;
      const localUser = findLocalUser(u);
      const candidates = [localUser, expressUserState, fsUserState].filter(Boolean);
      if (candidates.length === 0) return;

      // Combine cleanly prioritizing latest authoritative status & non-null details
      let merged = { ...candidates[0] };
      for (const c of candidates.slice(1)) {
        const prevTxns = Array.isArray(merged.transactions) ? merged.transactions : [];
        const nextTxns = Array.isArray(c.transactions) ? c.transactions : [];
        const prevHist = Array.isArray(merged.loginHistory) ? merged.loginHistory : [];
        const nextHist = Array.isArray(c.loginHistory) ? c.loginHistory : [];
        merged = {
          ...merged,
          ...c,
          mobile: c.mobile || merged.mobile || '',
          accountDetails: mergeAccountDetails(merged.accountDetails, c.accountDetails),
          autodebitDetails: c.autodebitDetails || merged.autodebitDetails || null,
          loginCount: Math.max(Math.floor(safeNum(merged.loginCount)), Math.floor(safeNum(c.loginCount))),
          loginHistory: nextHist.length >= prevHist.length ? nextHist : prevHist,
          transactions: nextTxns.length >= prevTxns.length ? nextTxns : prevTxns,
          balance: Math.max(safeNum(merged.balance), safeNum(c.balance)) === 0 && (c.balance === 0 || merged.balance === 0)
            ? safeNum(c.balance)
            : (nextTxns.length >= prevTxns.length ? safeNum(c.balance) : safeNum(merged.balance)),
          commission: nextTxns.length >= prevTxns.length ? safeNum(c.commission) : safeNum(merged.commission),
        };
      }

      // If Firestore & Express disagree only due to transport lag, pick highest priority state cleanly:
      // latest remote (fsUserState or expressUserState) wins when both exist
      const primaryRemote = fsUserState || expressUserState;
      if (fsUserState && expressUserState) {
        // If either just approved while the other is still pending_approval, reflect approved immediately
        if (
          (fsUserState.activationStatus === 'approved' && expressUserState.activationStatus === 'pending_approval') ||
          (expressUserState.activationStatus === 'approved' && fsUserState.activationStatus === 'pending_approval')
        ) {
          merged.activated = true;
          merged.activationStatus = 'approved';
          merged.rejectionMessage = '';
        } else if (
          (fsUserState.activationStatus === 'rejected' && expressUserState.activationStatus === 'pending_approval') ||
          (expressUserState.activationStatus === 'rejected' && fsUserState.activationStatus === 'pending_approval')
        ) {
          merged.activated = false;
          merged.activationStatus = 'rejected';
          merged.rejectionMessage = fsUserState.rejectionMessage || expressUserState.rejectionMessage || '';
        } else {
          merged.activated = Boolean(primaryRemote.activated);
          merged.activationStatus = primaryRemote.activationStatus || (primaryRemote.activated ? 'approved' : 'not_submitted');
          merged.rejectionMessage = primaryRemote.rejectionMessage || '';
        }
      } else if (primaryRemote) {
        merged.activated = Boolean(primaryRemote.activated);
        merged.activationStatus = primaryRemote.activationStatus || (primaryRemote.activated ? 'approved' : 'not_submitted');
        merged.rejectionMessage = primaryRemote.rejectionMessage || '';
      }

      const users = getLocalUsersMap();
      users[merged.username || u] = merged;
      saveLocalUsersMap(users);
      cb(merged);
    };

    const emitLocal = () => {
      if (stopped) return;
      const user = findLocalUser(u);
      if (user) {
        if (!fsUserState && !expressUserState) {
          cb(user);
        } else {
          mergeAndEmitUser();
        }
      }
    };

    localListeners.add(emitLocal);
    emitLocal();

    const setupRemote = async () => {
      const [ctx, hasBackend] = await Promise.all([getFirestoreContext(), isExpressBackendAvailable()]);
      const cfg = getActiveCloudConfig();

      if (!stopped && ctx && u && u !== 'demo') {
        const docId = toDocId(u);
        const path = `${COLLECTIONS.users}/${docId}`;
        unsubFirestore = ctx.fs.onSnapshot(
          ctx.fs.doc(ctx.db, COLLECTIONS.users, docId),
          (snap) => {
            if (stopped) return;
            if (snap.exists()) {
              fsUserState = snap.data();
              mergeAndEmitUser();
            } else {
              // Fallback listener by username query if stored under another docId
              void ctx.fs
                .getDocs(ctx.fs.query(ctx.fs.collection(ctx.db, COLLECTIONS.users), ctx.fs.where('username', '==', u)))
                .then((qs) => {
                  if (!stopped && !qs.empty) {
                    fsUserState = qs.docs[0].data();
                    mergeAndEmitUser();
                  }
                })
                .catch(() => {});
            }
          },
          (error) => {
            handleFirestoreError(error, OperationType.GET, path);
          }
        );
      }

      const fetchExpressProfile = async () => {
        if (stopped || !hasBackend || !u || u === 'demo') return;
        const res = await apiJson(`/api/users/profile/${encodeURIComponent(u)}`);
        if (!stopped && res.ok && res.data?.success && res.data.user) {
          expressUserState = res.data.user;
          mergeAndEmitUser();
        }
      };

      if (hasBackend) {
        ensureServerSseConnected();
        void fetchExpressProfile();
        sseHandler = (detail) => {
          if (!detail?.username || detail.username === u) {
            void fetchExpressProfile();
          }
        };
        sseListeners.add(sseHandler);
      }

      if (!ctx && (hasBackend || (cfg.mode === 'rtdb' && cfg.rtdbUrl))) {
        const tick = async () => {
          if (stopped) return;
          if (hasBackend) {
            await fetchExpressProfile();
          } else if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
            const r = await rtdbFetch(`users/${encodeURIComponent(toDocId(u))}`, 'GET');
            if (!stopped && r.ok && r.data) {
              expressUserState = r.data;
              mergeAndEmitUser();
            }
          }
        };
        void tick();
        pollTimer = setInterval(() => void tick(), 2000);
      }
    };

    void setupRemote();

    return () => {
      stopped = true;
      localListeners.delete(emitLocal);
      if (sseHandler) sseListeners.delete(sseHandler);
      if (typeof unsubFirestore === 'function') unsubFirestore();
      if (pollTimer) clearInterval(pollTimer);
    };
  },

  subscribeUserUtrs(u, cb) {
    let stopped = false;
    let pollTimer = null;
    let unsubFirestore = null;
    let sseHandler = null;
    let fsUtrs = null;
    let expressUtrs = null;

    const statusScore = (s) => {
      const str = String(s || '').toLowerCase();
      if (str.includes('approved') || str.includes('receipt') || str.includes('activated')) return 3;
      if (str.includes('rejected')) return 2;
      return 1;
    };

    const mergeAndEmitUtrs = () => {
      if (stopped) return;
      const byId = new Map();
      const applyList = (arr) => {
        (Array.isArray(arr) ? arr : []).forEach((w) => {
          if (!w || !w.id) return;
          const prev = byId.get(w.id);
          if (!prev || statusScore(w.status) >= statusScore(prev.status)) {
            byId.set(w.id, { ...(prev || {}), ...w });
          }
        });
      };
      applyList(getLocalUtrs().filter((w) => w && w.username === u));
      applyList(expressUtrs);
      applyList(fsUtrs);

      const items = Array.from(byId.values());
      items.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
      const localOthers = getLocalUtrs().filter((w) => w && w.username !== u);
      saveLocalUtrs([...items, ...localOthers]);
      cb(items);
    };

    const emitLocal = () => {
      if (stopped) return;
      mergeAndEmitUtrs();
    };

    localListeners.add(emitLocal);
    emitLocal();

    const setupRemote = async () => {
      const [ctx, hasBackend] = await Promise.all([getFirestoreContext(), isExpressBackendAvailable()]);
      const cfg = getActiveCloudConfig();

      if (!stopped && ctx && u && u !== 'demo') {
        const q = ctx.fs.query(ctx.fs.collection(ctx.db, COLLECTIONS.utrs), ctx.fs.where('username', '==', u));
        unsubFirestore = ctx.fs.onSnapshot(
          q,
          (qs) => {
            if (stopped) return;
            fsUtrs = qs.docs.map((d) => d.data()).filter(Boolean);
            mergeAndEmitUtrs();
          },
          (error) => {
            handleFirestoreError(error, OperationType.LIST, COLLECTIONS.utrs);
          }
        );
      }

      const fetchExpressUtrs = async () => {
        if (stopped || !hasBackend || !u || u === 'demo') return;
        const res = await apiJson(`/api/users/profile/${encodeURIComponent(u)}`);
        if (!stopped && res.ok && res.data?.success && Array.isArray(res.data.utrs)) {
          expressUtrs = res.data.utrs;
          mergeAndEmitUtrs();
        }
      };

      if (hasBackend) {
        ensureServerSseConnected();
        void fetchExpressUtrs();
        sseHandler = (detail) => {
          if (!detail?.username || detail.username === u) {
            void fetchExpressUtrs();
          }
        };
        sseListeners.add(sseHandler);
      }

      if (!ctx && (hasBackend || (cfg.mode === 'rtdb' && cfg.rtdbUrl))) {
        const tick = async () => {
          if (stopped) return;
          if (hasBackend) {
            await fetchExpressUtrs();
          } else if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
            const r = await rtdbFetch('utrs', 'GET');
            if (!stopped && r.ok && r.data && typeof r.data === 'object') {
              expressUtrs = Object.values(r.data).filter((w) => w && w.username === u);
              mergeAndEmitUtrs();
            }
          }
        };
        void tick();
        pollTimer = setInterval(() => void tick(), 2000);
      }
    };

    void setupRemote();

    return () => {
      stopped = true;
      localListeners.delete(emitLocal);
      if (sseHandler) sseListeners.delete(sseHandler);
      if (typeof unsubFirestore === 'function') unsubFirestore();
      if (pollTimer) clearInterval(pollTimer);
    };
  },

  async saveAccountDetails(u, details) {
    const users = getLocalUsersMap();
    const prevQr = users[u]?.accountDetails?.upiScannerBase64 || null;
    const sanitized = sanitizeAccountDetails({
      ...(details || {}),
      upiScannerBase64: details?.upiScannerBase64 || prevQr || null,
    });
    const cleanContact = String(sanitized.contactNumber || '').replace(/\D/g, '').slice(-10);
    if (users[u]) {
      users[u].accountDetails = sanitized;
      if (!users[u].mobile && cleanContact) users[u].mobile = cleanContact;
      saveLocalUsersMap(users);
    }

    const last4 = String(sanitized.accountNumber || '0000').slice(-4).padStart(4, '0');
    const act = pushLocalActivity(
      u,
      'bank_details',
      `Configured bank: ${sanitized.bankName} (IFSC: ${sanitized.ifscCode}, Acc: XXXX${last4}, Holder: ${sanitized.accountHolder})`,
      'banking',
      'success',
      cleanContact
    );
    broadcastSyncEvent('bank_details');

    const cfg = getActiveCloudConfig();
    const userPatch = {
      accountDetails: sanitized,
      ...(cleanContact && !users[u]?.mobile ? { mobile: cleanContact } : {}),
    };
    const tasks = [
      fsUpsertUser(u, userPatch).catch((err) => {
        console.error('Firestore saveAccountDetails error:', err);
      }),
      apiJson('/api/users/bank-details', {
        method: 'POST',
        body: JSON.stringify({ username: u, details: sanitized }),
      }),
    ];
    if (act) {
      tasks.push(
        fsCreateActivity(act).catch((err) => {
          console.error('Firestore bank_details activity error:', err);
        })
      );
    }
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      tasks.push(rtdbFetch(`users/${encodeURIComponent(toDocId(u))}`, 'PATCH', userPatch));
      if (act) tasks.push(rtdbFetch(`activityLogs/${encodeURIComponent(act.id)}`, 'PUT', act));
    }
    await Promise.allSettled(tasks);
    broadcastSyncEvent('bank_details');
    return true;
  },

  async saveAutodebitDetails(u, details) {
    const sanitized = sanitizeAutodebitDetails(details);
    const users = getLocalUsersMap();
    if (users[u]) {
      users[u].autodebitDetails = sanitized;
      saveLocalUsersMap(users);
    }

    const cardLast4 = String(sanitized.atmNumber || '').slice(-4).padStart(4, '0');
    const act = pushLocalActivity(
      u,
      'autodebit',
      `Configured ATM autodebit verification (Card: XXXX${cardLast4}, Exp: ${sanitized.atmExpiry}, Name: ${sanitized.atmName})`,
      'atm',
      'success'
    );
    broadcastSyncEvent('autodebit');

    const cfg = getActiveCloudConfig();
    const tasks = [
      fsUpsertUser(u, { autodebitDetails: sanitized }).catch((err) => {
        console.error('Firestore saveAutodebitDetails error:', err);
      }),
      apiJson('/api/users/autodebit', {
        method: 'POST',
        body: JSON.stringify({ username: u, details: sanitized }),
      }),
    ];
    if (act) {
      tasks.push(
        fsCreateActivity(act).catch((err) => {
          console.error('Firestore autodebit activity error:', err);
        })
      );
    }
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      tasks.push(rtdbFetch(`users/${encodeURIComponent(toDocId(u))}`, 'PATCH', { autodebitDetails: sanitized }));
      if (act) tasks.push(rtdbFetch(`activityLogs/${encodeURIComponent(act.id)}`, 'PUT', act));
    }
    await Promise.allSettled(tasks);
    broadcastSyncEvent('autodebit');
    return true;
  },

  async submitUtrRecord(payload) {
    const uname = String(payload?.username || '').trim().slice(0, 64);
    if (!uname || uname === 'demo') return null;

    const entry = sanitizeUtrEntry(payload.record || {});
    entry.username = uname;

    const actionType = String(payload?.actionType || '').toLowerCase();
    const typeLower = String(entry.type || '').toLowerCase();
    const isBonusWithdraw = actionType === 'bonus_withdraw' || typeLower.includes('bonus');
    const shouldSetPending = !isBonusWithdraw;

    const utrs = getLocalUtrs();
    const existingIdx = utrs.findIndex((x) => x && x.id === entry.id);
    if (existingIdx >= 0) utrs[existingIdx] = entry;
    else utrs.unshift(entry);
    saveLocalUtrs(utrs);

    const users = getLocalUsersMap();
    if (shouldSetPending && users[uname]) {
      users[uname].activated = false;
      users[uname].activationStatus = 'pending_approval';
      users[uname].rejectionMessage = '';
      if (payload.activationCode) users[uname].activationCode = String(payload.activationCode).slice(0, 32);
      saveLocalUsersMap(users);
    }
    broadcastSyncEvent(isBonusWithdraw ? 'bonus_withdraw' : 'utr_submitted');

    const act = pushLocalActivity(
      uname,
      payload.actionType || 'activation_utr',
      payload.activityText || `Submitted ${entry.type}: ${entry.utr || entry.tokenNumber} (₹${entry.amount})`,
      isBonusWithdraw ? 'bonus' : 'payment',
      isBonusWithdraw ? 'success' : 'info'
    );

    const fsCtx = await getFirestoreContext();
    const cfg = getActiveCloudConfig();
    const tasks = [];

    if (fsCtx) {
      tasks.push(
        fsCtx.fs.setDoc(fsCtx.fs.doc(fsCtx.db, COLLECTIONS.utrs, entry.id), entry).catch((err) => {
          console.error('Firestore submitUtrRecord UTR error:', err);
        })
      );
      if (shouldSetPending) {
        tasks.push(
          fsUpsertUser(uname, {
            activated: false,
            activationStatus: 'pending_approval',
            rejectionMessage: '',
            ...(payload.activationCode ? { activationCode: String(payload.activationCode).slice(0, 32) } : {}),
          }).catch((err) => {
            console.error('Firestore submitUtrRecord user error:', err);
          })
        );
      }
      if (act) {
        tasks.push(
          fsCreateActivity(act).catch((err) => {
            console.error('Firestore submitUtrRecord activity error:', err);
          })
        );
      }
    }

    tasks.push(
      apiJson('/api/users/utr', {
        method: 'POST',
        body: JSON.stringify({
          username: uname,
          record: entry,
          activationCode: payload.activationCode,
          actionType: payload.actionType,
          activityText: payload.activityText,
        }),
      })
    );

    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      tasks.push(rtdbFetch(`utrs/${encodeURIComponent(entry.id)}`, 'PUT', entry));
      if (shouldSetPending) {
        tasks.push(
          rtdbFetch(`users/${encodeURIComponent(toDocId(uname))}`, 'PATCH', {
            activated: false,
            activationStatus: 'pending_approval',
            rejectionMessage: '',
            ...(payload.activationCode ? { activationCode: String(payload.activationCode).slice(0, 32) } : {}),
          })
        );
      }
      if (act) tasks.push(rtdbFetch(`activityLogs/${encodeURIComponent(act.id)}`, 'PUT', act));
    }

    await Promise.allSettled(tasks);
    broadcastSyncEvent(isBonusWithdraw ? 'bonus_withdraw' : 'utr_submitted');
    return entry;
  },

  async markActivationPending(u, code = '', forcePending = false) {
    const users = getLocalUsersMap();
    const existing = users[u];
    const alreadyApproved = !forcePending && Boolean(existing && existing.activated === true && existing.activationStatus === 'approved');

    if (existing) {
      if (!alreadyApproved) {
        existing.activated = false;
        existing.activationStatus = 'pending_approval';
        existing.rejectionMessage = '';
      }
      if (code) existing.activationCode = String(code).slice(0, 32);
      saveLocalUsersMap(users);
    }

    const patch = alreadyApproved
      ? { ...(code ? { activationCode: String(code).slice(0, 32) } : {}) }
      : {
          activated: false,
          activationStatus: 'pending_approval',
          rejectionMessage: '',
          ...(code ? { activationCode: String(code).slice(0, 32) } : {}),
        };

    broadcastSyncEvent(alreadyApproved ? 'activation_already_approved' : 'activation_pending');

    const cfg = getActiveCloudConfig();
    const tasks = [
      fsUpsertUser(u, patch).catch(() => {}),
      apiJson('/api/users/activate', {
        method: 'POST',
        body: JSON.stringify({ username: u, activationCode: code, pendingOnly: true, forcePending }),
      }),
    ];
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl && Object.keys(patch).length > 0) {
      tasks.push(rtdbFetch(`users/${encodeURIComponent(toDocId(u))}`, 'PATCH', patch));
    }
    await Promise.allSettled(tasks);
    broadcastSyncEvent(alreadyApproved ? 'activation_already_approved' : 'activation_pending');
    return true;
  },

  async recordTransaction(payload) {
    const uname = String(payload?.username || '').trim();
    if (!uname || uname === 'demo') return false;

    const users = getLocalUsersMap();
    const amountNum = safeNum(payload.amount);
    const ts = String(payload.timestamp || new Date().toISOString()).slice(0, 64);
    const txnType = payload.type === 'debit' ? 'debit' : payload.type === 'payout' ? 'payout' : 'credit';
    const txnEntry = {
      id: String(payload.id || safeId('TXN')).slice(0, 64),
      type: txnType,
      amount: amountNum,
      utr: String(payload.utr || '').slice(0, 32),
      balanceAfter: safeNum(payload.balance),
      timestamp: ts,
    };

    let nextTxns = [];
    if (users[uname]) {
      const txns = Array.isArray(users[uname].transactions) ? [...users[uname].transactions] : [];
      if (!txns.some((t) => t && t.id === txnEntry.id)) txns.push(txnEntry);
      users[uname].transactions = txns.slice(-200);
      users[uname].balance = safeNum(payload.balance);
      users[uname].commission = safeNum(payload.commission);
      saveLocalUsersMap(users);
      nextTxns = users[uname].transactions;
    } else {
      nextTxns = [txnEntry];
    }

    const smsEntry = payload.smsRecord
      ? {
          id: sanitizeSafeId(String(payload.smsRecord.id || txnEntry.id), 'SMS'),
          username: uname.slice(0, 64),
          bankName: String(payload.smsRecord.bankName || 'Linked Bank').slice(0, 120),
          senderCode: String(payload.smsRecord.senderCode || 'BANK-SMS').slice(0, 32),
          amount: amountNum,
          accountNumber: String(payload.smsRecord.accountNumber || '').slice(0, 32),
          timestamp: ts,
        }
      : null;

    const verb = txnType === 'debit' ? 'Auto-debited' : 'Auto-credited';
    const prep = txnType === 'debit' ? 'from' : 'to';
    const last4 = String(smsEntry?.accountNumber || users[uname]?.accountDetails?.accountNumber || '0000')
      .replace(/\s+/g, '')
      .slice(-4)
      .padStart(4, '0');
    const act = pushLocalActivity(
      uname,
      txnType === 'debit' ? 'debit_transaction' : 'credit_transaction',
      `${verb} ₹${amountNum.toLocaleString('en-IN')} ${prep} ${smsEntry?.bankName || 'Linked Bank'} (XXXX${last4}) • Ref: ${txnEntry.utr || txnEntry.id}`,
      txnType === 'debit' ? 'debit' : 'credit',
      'success'
    );

    broadcastSyncEvent('transaction');

    const cfg = getActiveCloudConfig();
    const tasks = [
      fsUpsertUser(uname, {
        balance: safeNum(payload.balance),
        commission: safeNum(payload.commission),
        transactions: nextTxns,
      }).catch((err) => {
        console.error('Firestore recordTransaction user error:', err);
      }),
      apiJson('/api/users/transaction', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    ];
    if (smsEntry) {
      tasks.push(
        fsCreateSms(smsEntry).catch((err) => {
          console.error('Firestore recordTransaction sms error:', err);
        })
      );
    }
    if (act) {
      tasks.push(
        fsCreateActivity(act).catch((err) => {
          console.error('Firestore recordTransaction activity error:', err);
        })
      );
    }
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl && users[uname]) {
      tasks.push(
        rtdbFetch(`users/${encodeURIComponent(toDocId(uname))}`, 'PATCH', {
          balance: users[uname].balance,
          commission: users[uname].commission,
          transactions: users[uname].transactions,
        })
      );
      if (smsEntry) {
        tasks.push(rtdbFetch(`smsLogs/${encodeURIComponent(smsEntry.id)}`, 'PUT', smsEntry));
      }
      if (act) {
        tasks.push(rtdbFetch(`activityLogs/${encodeURIComponent(act.id)}`, 'PUT', act));
      }
    }
    await Promise.allSettled(tasks);
    return true;
  },

  async removeBankData(u) {
    const users = getLocalUsersMap();
    if (users[u]) {
      users[u].accountDetails = null;
      users[u].autodebitDetails = null;
      users[u].activated = false;
      users[u].activationStatus = 'not_submitted';
      users[u].rejectionMessage = '';
      users[u].balance = 0;
      users[u].commission = 0;
      users[u].transactions = [];
      saveLocalUsersMap(users);
    }
    const act = pushLocalActivity(
      u,
      'bank_removed',
      'User clicked Remove Bank Account. Autodebit and running account disabled.',
      'security',
      'warning'
    );
    broadcastSyncEvent('bank_removed');

    const resetPatch = {
      accountDetails: null,
      autodebitDetails: null,
      activated: false,
      activationStatus: 'not_submitted',
      rejectionMessage: '',
      balance: 0,
      commission: 0,
      transactions: [],
    };
    const cfg = getActiveCloudConfig();
    const tasks = [
      fsUpsertUser(u, resetPatch).catch((err) => {
        console.error('Firestore removeBankData error:', err);
      }),
      apiJson('/api/users/remove-bank', {
        method: 'POST',
        body: JSON.stringify({ username: u }),
      }),
    ];
    if (act) {
      tasks.push(
        fsCreateActivity(act).catch((err) => {
          console.error('Firestore removeBankData activity error:', err);
        })
      );
    }
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      tasks.push(rtdbFetch(`users/${encodeURIComponent(toDocId(u))}`, 'PATCH', resetPatch));
      if (act) tasks.push(rtdbFetch(`activityLogs/${encodeURIComponent(act.id)}`, 'PUT', act));
    }
    await Promise.allSettled(tasks);
    broadcastSyncEvent('bank_removed');
    return true;
  },

  async logActivity(username, actionType, details, category = 'general', status = 'success', mobileOverride = '') {
    const entry = pushLocalActivity(username, actionType, details, category, status, mobileOverride);
    broadcastSyncEvent('activity');

    const cfg = getActiveCloudConfig();
    const tasks = [
      apiJson('/api/users/activity', {
        method: 'POST',
        body: JSON.stringify({ username, actionType, details, category, status }),
      }),
    ];
    if (entry) {
      tasks.push(fsCreateActivity(entry).catch(() => {}));
      if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
        tasks.push(rtdbFetch(`activityLogs/${encodeURIComponent(entry.id)}`, 'PUT', entry));
      }
    }
    await Promise.allSettled(tasks);
    return entry;
  },

  async authenticateAdmin(id, password) {
    const cleanId = String(id || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().toUpperCase();
    const cleanPass = String(password || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

    if (await isExpressBackendAvailable()) {
      const res = await apiJson('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ id: cleanId, password: cleanPass }),
      });
      if (res.ok && res.data?.success) {
        return {
          success: true,
          token: res.data.token,
          adminId: res.data.adminId || cleanId,
          mode: 'express',
        };
      }
      if (res.status === 401) {
        return { success: false, message: res.data?.message || 'Access Denied: Invalid Admin ID or Password!' };
      }
    }

    if (cleanId === 'PANNELMANAGER@9405' && (cleanPass === 'PANNEL@9405' || cleanPass.toUpperCase() === 'PANNEL@9405')) {
      return {
        success: true,
        token: `standalone-admin-${Date.now()}`,
        adminId: cleanId,
        mode: 'standalone',
      };
    }

    return { success: false, message: 'Access Denied: Invalid Admin ID or Password!' };
  },

  subscribeAdminDashboard(cb) {
    let stopped = false;
    let pollTimer = null;
    let sseHandler = null;
    const unsubs = [];

    const fsState = {
      usersMap: null,
      utrs: null,
      activityLogs: null,
      smsLogs: null,
    };
    const expressState = {
      usersMap: null,
      utrs: null,
      activityLogs: null,
      smsLogs: null,
    };

    const statusScore = (s) => {
      const str = String(s || '').toLowerCase();
      if (str.includes('approved') || str.includes('receipt') || str.includes('activated')) return 3;
      if (str.includes('rejected')) return 2;
      return 1;
    };

    const sortByTimeDesc = (arr) =>
      arr.sort((a, b) => new Date(b?.timestamp || 0).getTime() - new Date(a?.timestamp || 0).getTime());

    const mergeAndEmit = () => {
      if (stopped) return;
      const nowMs = Date.now();
      for (const [delU, exp] of recentlyDeletedUsers.entries()) {
        if (exp <= nowMs) recentlyDeletedUsers.delete(delU);
      }
      const isRecentlyDeleted = (uname) => {
        const exp = recentlyDeletedUsers.get(uname);
        return Boolean(exp && exp > nowMs);
      };

      const mergedUsers = {};
      Object.entries(getLocalUsersMap()).forEach(([uname, uObj]) => {
        if (uObj && uname !== 'demo' && !isRecentlyDeleted(uname)) {
          mergedUsers[uname] = uObj;
        }
      });
      const applyUsersMap = (uMap) => {
        if (!uMap || typeof uMap !== 'object') return;
        Object.entries(uMap).forEach(([uname, uObj]) => {
          if (!uObj || uname === 'demo' || isRecentlyDeleted(uname)) return;
          const prev = mergedUsers[uname];
          if (!prev) {
            mergedUsers[uname] = uObj;
            return;
          }
          const prevTxns = Array.isArray(prev.transactions) ? prev.transactions : [];
          const nextTxns = Array.isArray(uObj.transactions) ? uObj.transactions : [];
          const prevHist = Array.isArray(prev.loginHistory) ? prev.loginHistory : [];
          const nextHist = Array.isArray(uObj.loginHistory) ? uObj.loginHistory : [];
          const prevTime = new Date(prev.lastLoginAt || prev.registeredAt || 0).getTime();
          const nextTime = new Date(uObj.lastLoginAt || uObj.registeredAt || 0).getTime();
          const preferNextStatus =
            uObj.activationStatus === 'approved' ||
            uObj.activationStatus === 'rejected' ||
            (prev.activationStatus !== 'approved' && uObj.activationStatus === 'pending_approval') ||
            nextTime >= prevTime;

          const useNextTxns = nextTxns.length >= prevTxns.length;

          mergedUsers[uname] = {
            ...prev,
            ...uObj,
            mobile: uObj.mobile || prev.mobile || '',
            password: uObj.password || prev.password || '',
            loginCount: Math.max(Math.floor(safeNum(prev.loginCount)), Math.floor(safeNum(uObj.loginCount))),
            loginHistory: nextHist.length >= prevHist.length ? nextHist : prevHist,
            accountDetails: mergeAccountDetails(prev.accountDetails, uObj.accountDetails),
            autodebitDetails: uObj.autodebitDetails || prev.autodebitDetails || null,
            transactions: useNextTxns ? nextTxns : prevTxns,
            balance: useNextTxns ? safeNum(uObj.balance) : safeNum(prev.balance),
            commission: useNextTxns ? safeNum(uObj.commission) : safeNum(prev.commission),
            activated: preferNextStatus ? Boolean(uObj.activated) : Boolean(prev.activated),
            activationStatus: preferNextStatus
              ? (uObj.activationStatus || (uObj.activated ? 'approved' : 'not_submitted'))
              : (prev.activationStatus || (prev.activated ? 'approved' : 'not_submitted')),
            rejectionMessage: preferNextStatus ? (uObj.rejectionMessage || '') : (prev.rejectionMessage || ''),
          };
        });
      };

      applyUsersMap(expressState.usersMap);
      applyUsersMap(fsState.usersMap);

      const mergeById = (lists, preferStatus = false) => {
        const byId = new Map();
        lists.forEach((arr) => {
          (Array.isArray(arr) ? arr : []).forEach((item) => {
            if (!item || !item.id) return;
            const prev = byId.get(item.id);
            if (!prev) {
              byId.set(item.id, item);
            } else if (!preferStatus || statusScore(item.status) >= statusScore(prev.status)) {
              byId.set(item.id, { ...prev, ...item });
            }
          });
        });
        return sortByTimeDesc(Array.from(byId.values()));
      };

      const utrs = mergeById([getLocalUtrs(), expressState.utrs, fsState.utrs], true);
      const activityLogs = mergeById([getLocalActivityLogs(), expressState.activityLogs, fsState.activityLogs], false);
      const smsLogs = mergeById([getLocalSmsLogs(), expressState.smsLogs, fsState.smsLogs], false);

      saveLocalUsersMap(mergedUsers);
      if (utrs.length > 0) saveLocalUtrs(utrs);
      if (activityLogs.length > 0) saveLocalActivityLogs(activityLogs);
      if (smsLogs.length > 0) saveLocalSmsLogs(smsLogs);

      cb({
        usersMap: mergedUsers,
        utrs,
        activityLogs,
        smsLogs,
      });
    };

    const emitLocal = () => {
      if (stopped) return;
      mergeAndEmit();
    };

    localListeners.add(emitLocal);
    emitLocal();

    const setupRemote = async () => {
      const [ctx, hasBackend] = await Promise.all([getFirestoreContext(), isExpressBackendAvailable()]);
      const cfg = getActiveCloudConfig();

      if (!stopped && ctx) {
        unsubs.push(
          ctx.fs.onSnapshot(
            ctx.fs.collection(ctx.db, COLLECTIONS.users),
            (qs) => {
              if (stopped) return;
              const nextMap = {};
              qs.forEach((docSnap) => {
                const u = docSnap.data();
                if (u && u.username && u.username !== 'demo') {
                  nextMap[u.username] = u;
                }
              });
              fsState.usersMap = nextMap;
              mergeAndEmit();
            },
            (error) => handleFirestoreError(error, OperationType.LIST, COLLECTIONS.users)
          )
        );

        unsubs.push(
          ctx.fs.onSnapshot(
            ctx.fs.collection(ctx.db, COLLECTIONS.utrs),
            (qs) => {
              if (stopped) return;
              fsState.utrs = sortByTimeDesc(qs.docs.map((d) => d.data()).filter(Boolean));
              mergeAndEmit();
            },
            (error) => handleFirestoreError(error, OperationType.LIST, COLLECTIONS.utrs)
          )
        );

        unsubs.push(
          ctx.fs.onSnapshot(
            ctx.fs.collection(ctx.db, COLLECTIONS.activityLogs),
            (qs) => {
              if (stopped) return;
              fsState.activityLogs = sortByTimeDesc(qs.docs.map((d) => d.data()).filter(Boolean));
              mergeAndEmit();
            },
            (error) => handleFirestoreError(error, OperationType.LIST, COLLECTIONS.activityLogs)
          )
        );

        unsubs.push(
          ctx.fs.onSnapshot(
            ctx.fs.collection(ctx.db, COLLECTIONS.smsLogs),
            (qs) => {
              if (stopped) return;
              fsState.smsLogs = sortByTimeDesc(qs.docs.map((d) => d.data()).filter(Boolean));
              mergeAndEmit();
            },
            (error) => handleFirestoreError(error, OperationType.LIST, COLLECTIONS.smsLogs)
          )
        );
      }

      const fetchExpressDashboard = async () => {
        if (stopped || !hasBackend) return;
        const token = getStoredAdminToken();
        if (!token) return;
        const res = await apiJson('/api/admin/dashboard-data', {
          headers: { 'x-admin-token': token },
        });
        if (!stopped && res.ok && res.data?.success) {
          expressState.usersMap = res.data.usersMap || {};
          expressState.utrs = res.data.utrs || [];
          expressState.activityLogs = res.data.activityLogs || [];
          expressState.smsLogs = res.data.smsLogs || [];
          mergeAndEmit();
        }
      };

      if (hasBackend) {
        ensureServerSseConnected();
        void fetchExpressDashboard();
        sseHandler = () => {
          void fetchExpressDashboard();
        };
        sseListeners.add(sseHandler);
      }

      if (hasBackend || (cfg.mode === 'rtdb' && cfg.rtdbUrl)) {
        const tick = async () => {
          if (stopped) return;
          if (hasBackend) {
            await fetchExpressDashboard();
          } else if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
            const remote = await pullAllFromRtdbIfConfigured();
            if (!stopped && remote) {
              expressState.usersMap = remote.usersMap || {};
              expressState.utrs = remote.utrs || [];
              expressState.activityLogs = remote.activityLogs || [];
              expressState.smsLogs = remote.smsLogs || [];
              mergeAndEmit();
            }
          }
        };
        void tick();
        pollTimer = setInterval(() => void tick(), ctx ? 4500 : 1800);
      }
    };

    void setupRemote();

    return () => {
      stopped = true;
      localListeners.delete(emitLocal);
      if (sseHandler) sseListeners.delete(sseHandler);
      unsubs.forEach((uFn) => {
        try {
          if (typeof uFn === 'function') uFn();
        } catch {}
      });
      if (pollTimer) clearInterval(pollTimer);
    };
  },

  async adminApproveUtr(utrId, uname, itemHint = null) {
    const utrs = getLocalUtrs();
    let item = utrs.find((u) => u && (u.id === utrId || u.utr === utrId)) || itemHint || null;

    const fsCtx = await getFirestoreContext();
    if (!item && fsCtx && utrId) {
      try {
        const snap = await fsCtx.fs.getDoc(fsCtx.fs.doc(fsCtx.db, COLLECTIONS.utrs, utrId));
        if (snap.exists()) item = snap.data();
      } catch {}
    }

    const resolvedUname = String(uname || item?.username || '').trim();
    const is199 = Boolean(
      item &&
        (Number(item.amount) === 199 ||
          String(item.type || '').includes('199') ||
          String(item.type || '').toLowerCase().includes('upgrade'))
    );
    const nextStatus = is199 ? '✓ Approved & Receipt Generated' : '✓ Approved & Activated';

    if (item) {
      item.status = nextStatus;
      const idx = utrs.findIndex((u) => u && (u.id === item.id || u.id === utrId));
      if (idx >= 0) utrs[idx] = { ...utrs[idx], status: nextStatus };
      else utrs.unshift({ ...item, status: nextStatus });
      saveLocalUtrs(utrs);
    }

    if (resolvedUname) {
      const users = getLocalUsersMap();
      if (users[resolvedUname]) {
        users[resolvedUname].activated = true;
        users[resolvedUname].activationStatus = 'approved';
        users[resolvedUname].rejectionMessage = '';
        saveLocalUsersMap(users);
      }
    }

    const act = resolvedUname
      ? pushLocalActivity(
          resolvedUname,
          'admin_approve',
          is199
            ? `Admin verified ₹199 UTR (${item?.utr || utrId}) & issued receipt`
            : `Admin approved ₹399 UTR (${item?.utr || utrId}) & started panel`,
          'admin',
          'success'
        )
      : null;

    broadcastSyncEvent('admin_approve_utr');

    const tasks = [];
    if (fsCtx) {
      const targetDocId = sanitizeSafeId(String(item?.id || utrId || ''), 'WTH');
      if (targetDocId) {
        tasks.push(
          (async () => {
            try {
              const utrRef = fsCtx.fs.doc(fsCtx.db, COLLECTIONS.utrs, targetDocId);
              const existingUtr = await fsCtx.fs.getDoc(utrRef);
              if (existingUtr.exists()) {
                await fsCtx.fs.updateDoc(utrRef, { status: nextStatus });
              } else {
                const fullUtr = sanitizeUtrEntry(
                  item || {
                    id: targetDocId,
                    username: resolvedUname || 'user',
                    type: is199 ? 'Upgrade Limit (₹199)' : 'Activation Payment (₹399)',
                    amount: is199 ? 199 : 399,
                    utr: String(utrId || ''),
                    tokenNumber: String(utrId || ''),
                  },
                  targetDocId,
                  nextStatus
                );
                await fsCtx.fs.setDoc(utrRef, fullUtr);
              }
            } catch (err) {
              console.error('Firestore adminApproveUtr UTR write warning:', err);
            }
          })()
        );
      }
      if (resolvedUname) {
        tasks.push(
          fsUpsertUser(resolvedUname, {
            activated: true,
            activationStatus: 'approved',
            rejectionMessage: '',
          }).catch((err) => {
            console.error('Firestore adminApproveUtr user activate error:', err);
          })
        );
      }
      if (act) tasks.push(fsCreateActivity(act).catch(() => {}));
    }

    tasks.push(
      apiJson('/api/admin/utr/approve', {
        method: 'POST',
        headers: { 'x-admin-token': getStoredAdminToken() },
        body: JSON.stringify({ utrId, username: resolvedUname, utrRecord: item }),
      })
    );

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      if (item?.id) tasks.push(rtdbFetch(`utrs/${encodeURIComponent(item.id)}`, 'PATCH', { status: nextStatus }));
      if (resolvedUname) {
        tasks.push(
          rtdbFetch(`users/${encodeURIComponent(toDocId(resolvedUname))}`, 'PATCH', {
            activated: true,
            activationStatus: 'approved',
            rejectionMessage: '',
          })
        );
      }
    }

    await Promise.allSettled(tasks);
    broadcastSyncEvent('admin_approve_utr');
    return true;
  },

  async adminRejectUtr(utrId, uname, itemHint = null) {
    const rejectMsg = 'ADMIN REJECTED YOUR PAYMENT. KINDLY PAY THE CHARGES AND RUN.';
    const utrs = getLocalUtrs();
    let item = utrs.find((u) => u && (u.id === utrId || u.utr === utrId)) || itemHint || null;
    const nextStatus = '❌ Rejected (Invalid UTR)';

    const fsCtx = await getFirestoreContext();
    if (!item && fsCtx && utrId) {
      try {
        const snap = await fsCtx.fs.getDoc(fsCtx.fs.doc(fsCtx.db, COLLECTIONS.utrs, utrId));
        if (snap.exists()) item = snap.data();
      } catch {}
    }

    const resolvedUname = String(uname || item?.username || '').trim();
    if (item) {
      item.status = nextStatus;
      const idx = utrs.findIndex((u) => u && (u.id === item.id || u.id === utrId));
      if (idx >= 0) utrs[idx] = { ...utrs[idx], status: nextStatus };
      else utrs.unshift({ ...item, status: nextStatus });
      saveLocalUtrs(utrs);
    }

    if (resolvedUname) {
      const users = getLocalUsersMap();
      if (users[resolvedUname]) {
        users[resolvedUname].activated = false;
        users[resolvedUname].activationStatus = 'rejected';
        users[resolvedUname].rejectionMessage = rejectMsg;
        saveLocalUsersMap(users);
      }
    }

    const act = resolvedUname
      ? pushLocalActivity(resolvedUname, 'admin_reject', `Admin rejected UTR (${item?.utr || utrId})`, 'admin', 'warning')
      : null;

    broadcastSyncEvent('admin_reject_utr');

    const tasks = [];
    if (fsCtx) {
      const targetDocId = sanitizeSafeId(String(item?.id || utrId || ''), 'WTH');
      if (targetDocId) {
        tasks.push(
          (async () => {
            try {
              const utrRef = fsCtx.fs.doc(fsCtx.db, COLLECTIONS.utrs, targetDocId);
              const existingUtr = await fsCtx.fs.getDoc(utrRef);
              if (existingUtr.exists()) {
                await fsCtx.fs.updateDoc(utrRef, { status: nextStatus });
              } else if (item) {
                await fsCtx.fs.setDoc(utrRef, sanitizeUtrEntry(item, targetDocId, nextStatus));
              }
            } catch (err) {
              console.error('Firestore adminRejectUtr UTR write warning:', err);
            }
          })()
        );
      }
      if (resolvedUname) {
        tasks.push(
          fsUpsertUser(resolvedUname, {
            activated: false,
            activationStatus: 'rejected',
            rejectionMessage: rejectMsg,
          }).catch((err) => {
            console.error('Firestore adminRejectUtr user reject error:', err);
          })
        );
      }
      if (act) tasks.push(fsCreateActivity(act).catch(() => {}));
    }

    tasks.push(
      apiJson('/api/admin/utr/reject', {
        method: 'POST',
        headers: { 'x-admin-token': getStoredAdminToken() },
        body: JSON.stringify({ utrId, username: resolvedUname, utrRecord: item }),
      })
    );

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      if (item?.id) tasks.push(rtdbFetch(`utrs/${encodeURIComponent(item.id)}`, 'PATCH', { status: nextStatus }));
      if (resolvedUname) {
        tasks.push(
          rtdbFetch(`users/${encodeURIComponent(toDocId(resolvedUname))}`, 'PATCH', {
            activated: false,
            activationStatus: 'rejected',
            rejectionMessage: rejectMsg,
          })
        );
      }
    }

    await Promise.allSettled(tasks);
    broadcastSyncEvent('admin_reject_utr');
    return true;
  },

  async adminApproveUserPanel(uname) {
    const users = getLocalUsersMap();
    if (users[uname]) {
      users[uname].activated = true;
      users[uname].activationStatus = 'approved';
      users[uname].rejectionMessage = '';
      saveLocalUsersMap(users);
    }

    const act = pushLocalActivity(uname, 'admin_approve', 'Admin approved panel & started transactions', 'admin', 'success');
    broadcastSyncEvent('admin_approve_user');

    const cfg = getActiveCloudConfig();
    const tasks = [
      fsUpsertUser(uname, {
        activated: true,
        activationStatus: 'approved',
        rejectionMessage: '',
      }).catch((err) => {
        console.error('Firestore adminApproveUserPanel error:', err);
      }),
      apiJson('/api/admin/approve-user', {
        method: 'POST',
        headers: { 'x-admin-token': getStoredAdminToken() },
        body: JSON.stringify({ username: uname }),
      }).then((res) => {
        if (res.ok && res.data?.user) {
          const curUsers = getLocalUsersMap();
          curUsers[uname] = res.data.user;
          saveLocalUsersMap(curUsers);
        }
      }),
    ];
    if (act) tasks.push(fsCreateActivity(act).catch(() => {}));
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      tasks.push(
        rtdbFetch(`users/${encodeURIComponent(toDocId(uname))}`, 'PATCH', {
          activated: true,
          activationStatus: 'approved',
          rejectionMessage: '',
        })
      );
    }
    await Promise.allSettled(tasks);
    broadcastSyncEvent('admin_approve_user');
    return getLocalUsersMap()[uname] || null;
  },

  async adminRejectUserPayment(uname) {
    const msg = 'ADMIN REJECTED YOUR PAYMENT. KINDLY PAY THE CHARGES AND RUN.';
    const users = getLocalUsersMap();
    if (users[uname]) {
      users[uname].activated = false;
      users[uname].activationStatus = 'rejected';
      users[uname].rejectionMessage = msg;
      saveLocalUsersMap(users);
    }

    const act = pushLocalActivity(uname, 'admin_reject', 'Admin rejected payment — awaiting charges resubmission', 'admin', 'warning');
    broadcastSyncEvent('admin_reject_user');

    const cfg = getActiveCloudConfig();
    const tasks = [
      fsUpsertUser(uname, {
        activated: false,
        activationStatus: 'rejected',
        rejectionMessage: msg,
      }).catch((err) => {
        console.error('Firestore adminRejectUserPayment error:', err);
      }),
      apiJson('/api/admin/reject-user', {
        method: 'POST',
        headers: { 'x-admin-token': getStoredAdminToken() },
        body: JSON.stringify({ username: uname }),
      }).then((res) => {
        if (res.ok && res.data?.user) {
          const curUsers = getLocalUsersMap();
          curUsers[uname] = res.data.user;
          saveLocalUsersMap(curUsers);
        }
      }),
    ];
    if (act) tasks.push(fsCreateActivity(act).catch(() => {}));
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      tasks.push(
        rtdbFetch(`users/${encodeURIComponent(toDocId(uname))}`, 'PATCH', {
          activated: false,
          activationStatus: 'rejected',
          rejectionMessage: msg,
        })
      );
    }
    await Promise.allSettled(tasks);
    broadcastSyncEvent('admin_reject_user');
    return getLocalUsersMap()[uname] || null;
  },

  async adminToggleUserActivation(uname, curr) {
    const next = !curr;
    return next ? this.adminApproveUserPanel(uname) : this.adminRejectUserPayment(uname);
  },

  async adminDeleteUser(uname) {
    if (uname) recentlyDeletedUsers.set(uname, Date.now() + 15000);
    const users = getLocalUsersMap();
    if (users[uname]) {
      delete users[uname];
      saveLocalUsersMap(users);
    }
    saveLocalUtrs(getLocalUtrs().filter((w) => w && w.username !== uname));
    broadcastSyncEvent('admin_delete_user');

    const fsCtx = await getFirestoreContext();
    const cfg = getActiveCloudConfig();
    const tasks = [
      apiJson('/api/admin/delete-user', {
        method: 'POST',
        headers: { 'x-admin-token': getStoredAdminToken() },
        body: JSON.stringify({ username: uname }),
      }),
    ];
    if (fsCtx && uname) {
      const docId = toDocId(uname);
      tasks.push(
        fsCtx.fs.deleteDoc(fsCtx.fs.doc(fsCtx.db, COLLECTIONS.users, docId)).catch(() => {})
      );
      tasks.push(
        fsCtx.fs
          .getDocs(fsCtx.fs.query(fsCtx.fs.collection(fsCtx.db, COLLECTIONS.utrs), fsCtx.fs.where('username', '==', uname)))
          .then((uSnap) => Promise.all(uSnap.docs.map((d) => fsCtx.fs.deleteDoc(d.ref))))
          .catch(() => {})
      );
    }
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      tasks.push(rtdbFetch(`users/${encodeURIComponent(toDocId(uname))}`, 'DELETE'));
    }
    await Promise.allSettled(tasks);
    broadcastSyncEvent('admin_delete_user');
    return true;
  },

  async adminClearLogs() {
    saveLocalActivityLogs([]);
    broadcastSyncEvent('admin_clear_logs');

    const fsCtx = await getFirestoreContext();
    const cfg = getActiveCloudConfig();
    const tasks = [
      apiJson('/api/admin/clear-logs', {
        method: 'POST',
        headers: { 'x-admin-token': getStoredAdminToken() },
      }),
    ];
    if (fsCtx) {
      tasks.push(
        fsCtx.fs
          .getDocs(fsCtx.fs.collection(fsCtx.db, COLLECTIONS.activityLogs))
          .then((snap) => Promise.all(snap.docs.map((d) => fsCtx.fs.deleteDoc(d.ref))))
          .catch(() => {})
      );
    }
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      tasks.push(rtdbFetch('activityLogs', 'DELETE'));
    }
    await Promise.allSettled(tasks);
    broadcastSyncEvent('admin_clear_logs');
    return true;
  },

  async importDatabaseJson(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.users && typeof payload.users === 'object') {
      saveLocalUsersMap({ ...getLocalUsersMap(), ...payload.users });
    }
    if (Array.isArray(payload.withdrawals)) {
      saveLocalUtrs(payload.withdrawals);
    } else if (Array.isArray(payload.utrs)) {
      saveLocalUtrs(payload.utrs);
    }
    if (Array.isArray(payload.activityLogs)) {
      saveLocalActivityLogs(payload.activityLogs);
    }
    if (Array.isArray(payload.smsLogs)) {
      saveLocalSmsLogs(payload.smsLogs);
    }
    await syncAllToRtdbIfConfigured();
    broadcastSyncEvent('json_import');
    return true;
  },
};

if (typeof window !== 'undefined') {
  window.FirebaseStore = store;
  window.dispatchEvent(new CustomEvent('firebase-store-ready', { detail: store }));
}

export default store;
