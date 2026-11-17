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

if (typeof window !== 'undefined' && !isStaticHostOrigin()) {
  void isExpressBackendAvailable();
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

async function getFirestoreContext() {
  const cfg = getActiveCloudConfig();
  if (cfg.mode !== 'firestore' || !cfg.firestoreConfig || !cfg.firestoreConfig.projectId) {
    return null;
  }
  if (firestoreContext) return firestoreContext;
  if (!firestoreRuntimePromise) {
    firestoreRuntimePromise = (async () => {
      try {
        const [appMod, fsMod] = await Promise.all([
          import(/* @vite-ignore */ 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js'),
          import(/* @vite-ignore */ 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js'),
        ]);
        const fbCfg = cfg.firestoreConfig;
        const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(fbCfg);
        const db = fbCfg.firestoreDatabaseId
          ? fsMod.getFirestore(app, fbCfg.firestoreDatabaseId)
          : fsMod.getFirestore(app);

        // Validate connection to Firestore on startup per SDK guidelines
        try {
          await fsMod.getDocFromServer(fsMod.doc(db, 'test', 'connection'));
        } catch (err) {
          if (err instanceof Error && err.message.includes('the client is offline')) {
            console.error('Please check your Firebase configuration.');
          }
        }

        firestoreContext = { app, db, fs: fsMod };
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
      details.upiScannerBase64 && String(details.upiScannerBase64).length <= 600000
        ? String(details.upiScannerBase64)
        : null;
  }
  return sanitized;
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

async function fsFindUser(identifier) {
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
  if (digits.length === 10) {
    try {
      const q = fs.query(fs.collection(db, COLLECTIONS.users), fs.where('mobile', '==', digits));
      const qs = await fs.getDocs(q);
      if (!qs.empty) {
        return qs.docs[0].data();
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, COLLECTIONS.users);
    }
  }

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
  if (!ctx || !uname || uname === 'demo') return false;
  const { db, fs } = ctx;
  const docId = toDocId(uname);
  const docRef = fs.doc(db, COLLECTIONS.users, docId);
  const path = `${COLLECTIONS.users}/${docId}`;

  let existsSnap = null;
  try {
    existsSnap = await fs.getDoc(docRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }

  if (existsSnap && existsSnap.exists()) {
    const filteredPatch = {};
    Object.entries(patch || {}).forEach(([kName, v]) => {
      if (ALLOWED_USER_UPDATE_KEYS.has(kName) && v !== undefined) {
        filteredPatch[kName] = v;
      }
    });
    if (Object.keys(filteredPatch).length === 0) return true;
    try {
      await fs.updateDoc(docRef, filteredPatch);
      return true;
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  } else {
    const local = findLocalUser(uname) || { username: uname, docId };
    const fullDoc = buildValidFirestoreUser(local, patch);
    try {
      await fs.setDoc(docRef, fullDoc);
      return true;
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  }
  return false;
}

async function fsCreateActivity(entry) {
  const ctx = await getFirestoreContext();
  if (!ctx || !entry || !entry.id || !entry.username || entry.username === 'demo') return false;
  const { db, fs } = ctx;
  const path = `${COLLECTIONS.activityLogs}/${entry.id}`;
  try {
    await fs.setDoc(fs.doc(db, COLLECTIONS.activityLogs, entry.id), entry);
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
  const path = `${COLLECTIONS.smsLogs}/${smsEntry.id}`;
  try {
    await fs.setDoc(fs.doc(db, COLLECTIONS.smsLogs, smsEntry.id), smsEntry);
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

    // Check Cloud Firestore uniqueness before creating
    try {
      const existingByName = await fsFindUser(uname);
      if (existingByName) {
        return { success: false, message: 'Username already taken! Please choose another.' };
      }
      if (cleanMobile) {
        const existingByMobile = await fsFindUser(cleanMobile);
        if (existingByMobile) {
          return { success: false, message: 'This mobile number is already registered! Please login.' };
        }
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

    if (await isExpressBackendAvailable()) {
      const res = await apiJson('/api/users/register', {
        method: 'POST',
        body: JSON.stringify({
          mobile: cleanMobile,
          username: uname,
          password: pwd,
          email: newUser.email,
        }),
      });
      if (res.ok && res.data?.success) {
        const finalUser = buildValidFirestoreUser(res.data.user || newUser);
        users[uname] = finalUser;
        saveLocalUsersMap(users);
        const act = pushLocalActivity(uname, 'register', `New user registered with OTP verified mobile +91 ${cleanMobile}`, 'registration', 'success', cleanMobile);
        try {
          await fsUpsertUser(uname, finalDocOverride(finalUser));
          if (act) await fsCreateActivity(act);
        } catch {}
        broadcastSyncEvent('register');
        return {
          success: true,
          message: res.data.message || 'Registration successful! Please login with your mobile number or username and password.',
          user: finalUser,
        };
      }
      if (res.data?.message) {
        return { success: false, message: res.data.message };
      }
    }

    users[uname] = newUser;
    saveLocalUsersMap(users);
    const act = pushLocalActivity(uname, 'register', `New user registered with OTP verified mobile +91 ${cleanMobile}`, 'registration', 'success', cleanMobile);

    // Sync to Cloud Firestore directly
    const fsCtx = await getFirestoreContext();
    if (fsCtx) {
      const path = `${COLLECTIONS.users}/${docId}`;
      try {
        await fsCtx.fs.setDoc(fsCtx.fs.doc(fsCtx.db, COLLECTIONS.users, docId), newUser);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
      if (act) {
        try {
          await fsCreateActivity(act);
        } catch {}
      }
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      await rtdbFetch(`users/${encodeURIComponent(docId)}`, 'PUT', newUser);
      if (act) await rtdbFetch(`activityLogs/${encodeURIComponent(act.id)}`, 'PUT', act);
    }

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
        body: JSON.stringify({ identifier, password }),
      });
      if (res.ok && res.data?.success && res.data.user) {
        const users = getLocalUsersMap();
        users[res.data.user.username] = res.data.user;
        saveLocalUsersMap(users);
        syncUserStatsToLocalKeys(res.data.user);
        try {
          await fsUpsertUser(res.data.user.username, {
            lastLoginAt: res.data.user.lastLoginAt,
            loginCount: res.data.user.loginCount,
            loginHistory: res.data.user.loginHistory,
          });
        } catch {}
        broadcastSyncEvent('login');
        return {
          success: true,
          username: res.data.username || res.data.user.username,
          message: res.data.message || 'Login successful!',
          user: res.data.user,
        };
      }
      if (res.status === 401 || res.status === 404) {
        const localHit = findLocalUser(identifier);
        const fsHit = localHit || (await fsFindUser(identifier).catch(() => null));
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
      const remoteFsUser = await fsFindUser(identifier);
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

    try {
      await fsUpsertUser(userRecord.username, {
        lastLoginAt: now,
        loginCount: nextCount,
        loginHistory: nextHistory,
      });
      if (act) await fsCreateActivity(act);
    } catch {}

    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      await rtdbFetch(`users/${encodeURIComponent(toDocId(userRecord.username))}`, 'PATCH', {
        lastLoginAt: now,
        loginCount: nextCount,
        loginHistory: nextHistory,
      });
      if (act) await rtdbFetch(`activityLogs/${encodeURIComponent(act.id)}`, 'PUT', act);
    }

    broadcastSyncEvent('login');
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
      const fsUser = await fsFindUser(u);
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

    const emitLocal = () => {
      if (stopped) return;
      const user = findLocalUser(u);
      if (user) cb(user);
    };

    localListeners.add(emitLocal);
    emitLocal();

    const setupRemote = async () => {
      const ctx = await getFirestoreContext();
      if (!stopped && ctx && u && u !== 'demo') {
        const docId = toDocId(u);
        const path = `${COLLECTIONS.users}/${docId}`;
        unsubFirestore = ctx.fs.onSnapshot(
          ctx.fs.doc(ctx.db, COLLECTIONS.users, docId),
          (snap) => {
            if (stopped || !snap.exists()) return;
            const userData = snap.data();
            const users = getLocalUsersMap();
            users[userData.username || u] = userData;
            saveLocalUsersMap(users);
            cb(userData);
          },
          (error) => {
            handleFirestoreError(error, OperationType.GET, path);
          }
        );
        return;
      }

      const hasBackend = await isExpressBackendAvailable();
      const cfg = getActiveCloudConfig();
      if (!hasBackend && cfg.mode !== 'rtdb') return;

      const tick = async () => {
        if (stopped) return;
        if (hasBackend) {
          const res = await apiJson(`/api/users/profile/${encodeURIComponent(u)}`);
          if (!stopped && res.ok && res.data?.success && res.data.user) {
            const users = getLocalUsersMap();
            users[res.data.user.username] = res.data.user;
            saveLocalUsersMap(users);
            cb(res.data.user);
          }
        } else if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
          const r = await rtdbFetch(`users/${encodeURIComponent(toDocId(u))}`, 'GET');
          if (!stopped && r.ok && r.data) {
            const users = getLocalUsersMap();
            users[r.data.username || u] = r.data;
            saveLocalUsersMap(users);
            cb(r.data);
          }
        }
      };

      void tick();
      pollTimer = setInterval(() => void tick(), 2500);
    };

    void setupRemote();

    return () => {
      stopped = true;
      localListeners.delete(emitLocal);
      if (typeof unsubFirestore === 'function') unsubFirestore();
      if (pollTimer) clearInterval(pollTimer);
    };
  },

  subscribeUserUtrs(u, cb) {
    let stopped = false;
    let pollTimer = null;
    let unsubFirestore = null;

    const emitLocal = () => {
      if (stopped) return;
      const items = getLocalUtrs().filter((w) => w && w.username === u);
      items.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
      cb(items);
    };

    localListeners.add(emitLocal);
    emitLocal();

    const setupRemote = async () => {
      const ctx = await getFirestoreContext();
      if (!stopped && ctx && u && u !== 'demo') {
        const q = ctx.fs.query(ctx.fs.collection(ctx.db, COLLECTIONS.utrs), ctx.fs.where('username', '==', u));
        unsubFirestore = ctx.fs.onSnapshot(
          q,
          (qs) => {
            if (stopped) return;
            const items = qs.docs.map((d) => d.data()).filter(Boolean);
            items.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
            const localOthers = getLocalUtrs().filter((w) => w && w.username !== u);
            saveLocalUtrs([...items, ...localOthers]);
            cb(items);
          },
          (error) => {
            handleFirestoreError(error, OperationType.LIST, COLLECTIONS.utrs);
          }
        );
        return;
      }

      const hasBackend = await isExpressBackendAvailable();
      const cfg = getActiveCloudConfig();
      if (!hasBackend && cfg.mode !== 'rtdb') return;

      const tick = async () => {
        if (stopped) return;
        if (hasBackend) {
          const res = await apiJson(`/api/users/profile/${encodeURIComponent(u)}`);
          if (!stopped && res.ok && res.data?.success && Array.isArray(res.data.utrs)) {
            const items = [...res.data.utrs];
            items.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
            cb(items);
          }
        } else if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
          const r = await rtdbFetch('utrs', 'GET');
          if (!stopped && r.ok && r.data && typeof r.data === 'object') {
            const items = Object.values(r.data).filter((w) => w && w.username === u);
            items.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
            cb(items);
          }
        }
      };

      void tick();
      pollTimer = setInterval(() => void tick(), 2500);
    };

    void setupRemote();

    return () => {
      stopped = true;
      localListeners.delete(emitLocal);
      if (typeof unsubFirestore === 'function') unsubFirestore();
      if (pollTimer) clearInterval(pollTimer);
    };
  },

  async saveAccountDetails(u, details) {
    const sanitized = sanitizeAccountDetails(details);
    const users = getLocalUsersMap();
    if (users[u]) {
      users[u].accountDetails = sanitized;
      saveLocalUsersMap(users);
    }

    try {
      await fsUpsertUser(u, { accountDetails: sanitized });
    } catch {}

    if (await isExpressBackendAvailable()) {
      await apiJson('/api/users/bank-details', {
        method: 'POST',
        body: JSON.stringify({ username: u, details: sanitized }),
      });
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      await rtdbFetch(`users/${encodeURIComponent(toDocId(u))}`, 'PATCH', { accountDetails: sanitized });
    }

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

    try {
      await fsUpsertUser(u, { autodebitDetails: sanitized });
    } catch {}

    if (await isExpressBackendAvailable()) {
      await apiJson('/api/users/autodebit', {
        method: 'POST',
        body: JSON.stringify({ username: u, details: sanitized }),
      });
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      await rtdbFetch(`users/${encodeURIComponent(toDocId(u))}`, 'PATCH', { autodebitDetails: sanitized });
    }

    broadcastSyncEvent('autodebit');
    return true;
  },

  async submitUtrRecord(payload) {
    const uname = String(payload?.username || '').trim().slice(0, 64);
    if (!uname || uname === 'demo') return null;

    const rec = payload.record || {};
    const id = sanitizeSafeId(String(rec.id || ''), 'WTH');
    const entry = {
      id,
      username: uname,
      type: String(rec.type || 'UTR Submission').slice(0, 100),
      amount: safeNum(rec.amount),
      utr: String(rec.utr || '').slice(0, 64),
      tokenNumber: String(rec.tokenNumber || rec.utr || '').slice(0, 64),
      status: String(rec.status || 'Pending Admin Approval').slice(0, 80),
      bank: String(rec.bank || '').slice(0, 120),
      ifsc: String(rec.ifsc || '').slice(0, 20),
      accNumber: String(rec.accNumber || '').slice(0, 32),
      accountHolder: String(rec.accountHolder || '').slice(0, 120),
      contact: String(rec.contact || '').slice(0, 20),
      timestamp: String(rec.timestamp || new Date().toISOString()).slice(0, 64),
    };

    const utrs = getLocalUtrs();
    const existingIdx = utrs.findIndex((x) => x && x.id === id);
    if (existingIdx >= 0) utrs[existingIdx] = entry;
    else utrs.unshift(entry);
    saveLocalUtrs(utrs);

    const users = getLocalUsersMap();
    if (users[uname]) {
      users[uname].activated = false;
      users[uname].activationStatus = 'pending_approval';
      users[uname].rejectionMessage = '';
      if (payload.activationCode) users[uname].activationCode = String(payload.activationCode).slice(0, 32);
      saveLocalUsersMap(users);
    }

    const fsCtx = await getFirestoreContext();
    if (fsCtx) {
      const utrPath = `${COLLECTIONS.utrs}/${id}`;
      try {
        await fsCtx.fs.setDoc(fsCtx.fs.doc(fsCtx.db, COLLECTIONS.utrs, id), entry);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, utrPath);
      }
      try {
        await fsUpsertUser(uname, {
          activated: false,
          activationStatus: 'pending_approval',
          rejectionMessage: '',
          ...(payload.activationCode ? { activationCode: String(payload.activationCode).slice(0, 32) } : {}),
        });
      } catch {}
    }

    if (await isExpressBackendAvailable()) {
      await apiJson('/api/users/utr', {
        method: 'POST',
        body: JSON.stringify({
          username: uname,
          record: entry,
          activationCode: payload.activationCode,
          actionType: payload.actionType,
          activityText: payload.activityText,
        }),
      });
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      await rtdbFetch(`utrs/${encodeURIComponent(id)}`, 'PUT', entry);
      await rtdbFetch(`users/${encodeURIComponent(toDocId(uname))}`, 'PATCH', {
        activated: false,
        activationStatus: 'pending_approval',
        rejectionMessage: '',
        ...(payload.activationCode ? { activationCode: String(payload.activationCode).slice(0, 32) } : {}),
      });
    }

    broadcastSyncEvent('utr_submitted');
    return entry;
  },

  async markActivationPending(u, code = '') {
    const users = getLocalUsersMap();
    if (users[u]) {
      users[u].activated = false;
      users[u].activationStatus = 'pending_approval';
      users[u].rejectionMessage = '';
      if (code) users[u].activationCode = String(code).slice(0, 32);
      saveLocalUsersMap(users);
    }

    try {
      await fsUpsertUser(u, {
        activated: false,
        activationStatus: 'pending_approval',
        rejectionMessage: '',
        ...(code ? { activationCode: String(code).slice(0, 32) } : {}),
      });
    } catch {}

    if (await isExpressBackendAvailable()) {
      await apiJson('/api/users/activate', {
        method: 'POST',
        body: JSON.stringify({ username: u, activationCode: code, pendingOnly: true }),
      });
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      await rtdbFetch(`users/${encodeURIComponent(toDocId(u))}`, 'PATCH', {
        activated: false,
        activationStatus: 'pending_approval',
        rejectionMessage: '',
        ...(code ? { activationCode: String(code).slice(0, 32) } : {}),
      });
    }

    broadcastSyncEvent('activation_pending');
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

    try {
      await fsUpsertUser(uname, {
        balance: safeNum(payload.balance),
        commission: safeNum(payload.commission),
        transactions: nextTxns,
      });
      if (smsEntry) await fsCreateSms(smsEntry);
    } catch {}

    if (await isExpressBackendAvailable()) {
      await apiJson('/api/users/transaction', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl && users[uname]) {
      await rtdbFetch(`users/${encodeURIComponent(toDocId(uname))}`, 'PATCH', {
        balance: users[uname].balance,
        commission: users[uname].commission,
        transactions: users[uname].transactions,
      });
      if (smsEntry) {
        await rtdbFetch(`smsLogs/${encodeURIComponent(smsEntry.id)}`, 'PUT', smsEntry);
      }
    }

    broadcastSyncEvent('transaction');
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

    try {
      await fsUpsertUser(u, {
        accountDetails: null,
        autodebitDetails: null,
        activated: false,
        activationStatus: 'not_submitted',
        rejectionMessage: '',
        balance: 0,
        commission: 0,
        transactions: [],
      });
    } catch {}

    if (await isExpressBackendAvailable()) {
      await apiJson('/api/users/remove-bank', {
        method: 'POST',
        body: JSON.stringify({ username: u }),
      });
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      await rtdbFetch(`users/${encodeURIComponent(toDocId(u))}`, 'PATCH', {
        accountDetails: null,
        autodebitDetails: null,
        activated: false,
        activationStatus: 'not_submitted',
        rejectionMessage: '',
        balance: 0,
        commission: 0,
        transactions: [],
      });
    }

    broadcastSyncEvent('bank_removed');
    return true;
  },

  async logActivity(username, actionType, details, category = 'general', status = 'success', mobileOverride = '') {
    const entry = pushLocalActivity(username, actionType, details, category, status, mobileOverride);
    if (entry) {
      try {
        await fsCreateActivity(entry);
      } catch {}
    }
    if (await isExpressBackendAvailable()) {
      await apiJson('/api/users/activity', {
        method: 'POST',
        body: JSON.stringify({ username, actionType, details, category, status }),
      });
    }
    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl && entry) {
      await rtdbFetch(`activityLogs/${encodeURIComponent(entry.id)}`, 'PUT', entry);
    }
    broadcastSyncEvent('activity');
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
    const unsubs = [];

    const state = {
      usersMap: getLocalUsersMap(),
      utrs: getLocalUtrs(),
      activityLogs: getLocalActivityLogs(),
      smsLogs: getLocalSmsLogs(),
    };

    const emitState = () => {
      if (stopped) return;
      cb({
        usersMap: { ...state.usersMap },
        utrs: [...state.utrs],
        activityLogs: [...state.activityLogs],
        smsLogs: [...state.smsLogs],
      });
    };

    const emitLocal = () => {
      state.usersMap = { ...state.usersMap, ...getLocalUsersMap() };
      const localUtrs = getLocalUtrs();
      if (localUtrs.length && state.utrs.length === 0) state.utrs = localUtrs;
      const localLogs = getLocalActivityLogs();
      if (localLogs.length && state.activityLogs.length === 0) state.activityLogs = localLogs;
      const localSms = getLocalSmsLogs();
      if (localSms.length && state.smsLogs.length === 0) state.smsLogs = localSms;
      emitState();
    };

    localListeners.add(emitLocal);
    emitLocal();

    const setupRemote = async () => {
      const ctx = await getFirestoreContext();
      if (!stopped && ctx) {
        const sortByTimeDesc = (arr) =>
          arr.sort((a, b) => new Date(b?.timestamp || 0).getTime() - new Date(a?.timestamp || 0).getTime());

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
              state.usersMap = nextMap;
              saveLocalUsersMap(nextMap);
              emitState();
            },
            (error) => handleFirestoreError(error, OperationType.LIST, COLLECTIONS.users)
          )
        );

        unsubs.push(
          ctx.fs.onSnapshot(
            ctx.fs.collection(ctx.db, COLLECTIONS.utrs),
            (qs) => {
              if (stopped) return;
              const list = sortByTimeDesc(qs.docs.map((d) => d.data()).filter(Boolean));
              state.utrs = list;
              saveLocalUtrs(list);
              emitState();
            },
            (error) => handleFirestoreError(error, OperationType.LIST, COLLECTIONS.utrs)
          )
        );

        unsubs.push(
          ctx.fs.onSnapshot(
            ctx.fs.collection(ctx.db, COLLECTIONS.activityLogs),
            (qs) => {
              if (stopped) return;
              const list = sortByTimeDesc(qs.docs.map((d) => d.data()).filter(Boolean));
              state.activityLogs = list;
              saveLocalActivityLogs(list);
              emitState();
            },
            (error) => handleFirestoreError(error, OperationType.LIST, COLLECTIONS.activityLogs)
          )
        );

        unsubs.push(
          ctx.fs.onSnapshot(
            ctx.fs.collection(ctx.db, COLLECTIONS.smsLogs),
            (qs) => {
              if (stopped) return;
              const list = sortByTimeDesc(qs.docs.map((d) => d.data()).filter(Boolean));
              state.smsLogs = list;
              saveLocalSmsLogs(list);
              emitState();
            },
            (error) => handleFirestoreError(error, OperationType.LIST, COLLECTIONS.smsLogs)
          )
        );
        return;
      }

      const hasBackend = await isExpressBackendAvailable();
      const cfg = getActiveCloudConfig();
      if (!hasBackend && cfg.mode !== 'rtdb') return;

      const tick = async () => {
        if (stopped) return;
        if (hasBackend) {
          const token = getStoredAdminToken();
          if (!token) return;
          const res = await apiJson('/api/admin/dashboard-data', {
            headers: { 'x-admin-token': token },
          });
          if (!stopped && res.ok && res.data?.success) {
            state.usersMap = res.data.usersMap || {};
            state.utrs = res.data.utrs || [];
            state.activityLogs = res.data.activityLogs || [];
            state.smsLogs = res.data.smsLogs || [];
            emitState();
          }
        } else if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
          const remote = await pullAllFromRtdbIfConfigured();
          if (!stopped && remote) {
            state.usersMap = remote.usersMap || {};
            state.utrs = remote.utrs || [];
            state.activityLogs = remote.activityLogs || [];
            state.smsLogs = remote.smsLogs || [];
            emitState();
          }
        }
      };

      void tick();
      pollTimer = setInterval(() => void tick(), 2500);
    };

    void setupRemote();

    return () => {
      stopped = true;
      localListeners.delete(emitLocal);
      unsubs.forEach((uFn) => {
        try {
          if (typeof uFn === 'function') uFn();
        } catch {}
      });
      if (pollTimer) clearInterval(pollTimer);
    };
  },

  async adminApproveUtr(utrId, uname) {
    const utrs = getLocalUtrs();
    let item = utrs.find((u) => u && (u.id === utrId || u.utr === utrId));

    const fsCtx = await getFirestoreContext();
    if (!item && fsCtx && utrId) {
      try {
        const snap = await fsCtx.fs.getDoc(fsCtx.fs.doc(fsCtx.db, COLLECTIONS.utrs, utrId));
        if (snap.exists()) item = snap.data();
      } catch {}
    }

    const is199 = Boolean(
      item &&
        (Number(item.amount) === 199 ||
          String(item.type || '').includes('199') ||
          String(item.type || '').toLowerCase().includes('upgrade'))
    );
    const nextStatus = is199 ? '✓ Approved & Receipt Generated' : '✓ Approved & Activated';

    if (item) {
      item.status = nextStatus;
      saveLocalUtrs(utrs);
    }

    const users = getLocalUsersMap();
    if (users[uname]) {
      users[uname].activated = true;
      users[uname].activationStatus = 'approved';
      users[uname].rejectionMessage = '';
      saveLocalUsersMap(users);
    }

    const act = pushLocalActivity(
      uname,
      'admin_approve',
      is199 ? `Admin verified ₹199 UTR (${item?.utr || utrId}) & issued receipt` : `Admin approved ₹399 UTR (${item?.utr || utrId}) & started panel`,
      'admin',
      'success'
    );

    if (fsCtx) {
      const targetDocId = item?.id || utrId;
      if (targetDocId) {
        const utrPath = `${COLLECTIONS.utrs}/${targetDocId}`;
        try {
          await fsCtx.fs.updateDoc(fsCtx.fs.doc(fsCtx.db, COLLECTIONS.utrs, targetDocId), { status: nextStatus });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, utrPath);
        }
      }
      if (uname) {
        await fsUpsertUser(uname, {
          activated: true,
          activationStatus: 'approved',
          rejectionMessage: '',
        });
      }
      if (act) await fsCreateActivity(act);
    }

    if (await isExpressBackendAvailable()) {
      await apiJson('/api/admin/utr/approve', {
        method: 'POST',
        headers: { 'x-admin-token': getStoredAdminToken() },
        body: JSON.stringify({ utrId, username: uname }),
      });
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      if (item?.id) await rtdbFetch(`utrs/${encodeURIComponent(item.id)}`, 'PATCH', { status: nextStatus });
      if (uname) {
        await rtdbFetch(`users/${encodeURIComponent(toDocId(uname))}`, 'PATCH', {
          activated: true,
          activationStatus: 'approved',
          rejectionMessage: '',
        });
      }
    }

    broadcastSyncEvent('admin_approve_utr');
    return true;
  },

  async adminRejectUtr(utrId, uname) {
    const rejectMsg = 'ADMIN REJECTED YOUR PAYMENT. KINDLY PAY THE CHARGES AND RUN.';
    const utrs = getLocalUtrs();
    const item = utrs.find((u) => u && (u.id === utrId || u.utr === utrId));
    const nextStatus = '❌ Rejected (Invalid UTR)';
    if (item) {
      item.status = nextStatus;
      saveLocalUtrs(utrs);
    }

    const users = getLocalUsersMap();
    if (users[uname]) {
      users[uname].activated = false;
      users[uname].activationStatus = 'rejected';
      users[uname].rejectionMessage = rejectMsg;
      saveLocalUsersMap(users);
    }

    const act = pushLocalActivity(uname, 'admin_reject', `Admin rejected UTR (${item?.utr || utrId})`, 'admin', 'warning');

    const fsCtx = await getFirestoreContext();
    if (fsCtx) {
      const targetDocId = item?.id || utrId;
      if (targetDocId) {
        const utrPath = `${COLLECTIONS.utrs}/${targetDocId}`;
        try {
          await fsCtx.fs.updateDoc(fsCtx.fs.doc(fsCtx.db, COLLECTIONS.utrs, targetDocId), { status: nextStatus });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, utrPath);
        }
      }
      if (uname) {
        await fsUpsertUser(uname, {
          activated: false,
          activationStatus: 'rejected',
          rejectionMessage: rejectMsg,
        });
      }
      if (act) await fsCreateActivity(act);
    }

    if (await isExpressBackendAvailable()) {
      await apiJson('/api/admin/utr/reject', {
        method: 'POST',
        headers: { 'x-admin-token': getStoredAdminToken() },
        body: JSON.stringify({ utrId, username: uname }),
      });
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      if (item?.id) await rtdbFetch(`utrs/${encodeURIComponent(item.id)}`, 'PATCH', { status: nextStatus });
      if (uname) {
        await rtdbFetch(`users/${encodeURIComponent(toDocId(uname))}`, 'PATCH', {
          activated: false,
          activationStatus: 'rejected',
          rejectionMessage: rejectMsg,
        });
      }
    }

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

    try {
      await fsUpsertUser(uname, {
        activated: true,
        activationStatus: 'approved',
        rejectionMessage: '',
      });
      if (act) await fsCreateActivity(act);
    } catch {}

    if (await isExpressBackendAvailable()) {
      const res = await apiJson('/api/admin/approve-user', {
        method: 'POST',
        headers: { 'x-admin-token': getStoredAdminToken() },
        body: JSON.stringify({ username: uname }),
      });
      if (res.ok && res.data?.user) {
        users[uname] = res.data.user;
        saveLocalUsersMap(users);
      }
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      await rtdbFetch(`users/${encodeURIComponent(toDocId(uname))}`, 'PATCH', {
        activated: true,
        activationStatus: 'approved',
        rejectionMessage: '',
      });
    }

    broadcastSyncEvent('admin_approve_user');
    return users[uname] || null;
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

    try {
      await fsUpsertUser(uname, {
        activated: false,
        activationStatus: 'rejected',
        rejectionMessage: msg,
      });
      if (act) await fsCreateActivity(act);
    } catch {}

    if (await isExpressBackendAvailable()) {
      const res = await apiJson('/api/admin/reject-user', {
        method: 'POST',
        headers: { 'x-admin-token': getStoredAdminToken() },
        body: JSON.stringify({ username: uname }),
      });
      if (res.ok && res.data?.user) {
        users[uname] = res.data.user;
        saveLocalUsersMap(users);
      }
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      await rtdbFetch(`users/${encodeURIComponent(toDocId(uname))}`, 'PATCH', {
        activated: false,
        activationStatus: 'rejected',
        rejectionMessage: msg,
      });
    }

    broadcastSyncEvent('admin_reject_user');
    return users[uname] || null;
  },

  async adminToggleUserActivation(uname, curr) {
    const next = !curr;
    return next ? this.adminApproveUserPanel(uname) : this.adminRejectUserPayment(uname);
  },

  async adminDeleteUser(uname) {
    const users = getLocalUsersMap();
    if (users[uname]) {
      delete users[uname];
      saveLocalUsersMap(users);
    }
    saveLocalUtrs(getLocalUtrs().filter((w) => w && w.username !== uname));

    const fsCtx = await getFirestoreContext();
    if (fsCtx && uname) {
      const docId = toDocId(uname);
      const userPath = `${COLLECTIONS.users}/${docId}`;
      try {
        await fsCtx.fs.deleteDoc(fsCtx.fs.doc(fsCtx.db, COLLECTIONS.users, docId));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, userPath);
      }
      try {
        const uQ = fsCtx.fs.query(fsCtx.fs.collection(fsCtx.db, COLLECTIONS.utrs), fsCtx.fs.where('username', '==', uname));
        const uSnap = await fsCtx.fs.getDocs(uQ);
        await Promise.all(uSnap.docs.map((d) => fsCtx.fs.deleteDoc(d.ref)));
      } catch {}
    }

    if (await isExpressBackendAvailable()) {
      await apiJson('/api/admin/delete-user', {
        method: 'POST',
        headers: { 'x-admin-token': getStoredAdminToken() },
        body: JSON.stringify({ username: uname }),
      });
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      await rtdbFetch(`users/${encodeURIComponent(toDocId(uname))}`, 'DELETE');
    }

    broadcastSyncEvent('admin_delete_user');
    return true;
  },

  async adminClearLogs() {
    saveLocalActivityLogs([]);

    const fsCtx = await getFirestoreContext();
    if (fsCtx) {
      try {
        const snap = await fsCtx.fs.getDocs(fsCtx.fs.collection(fsCtx.db, COLLECTIONS.activityLogs));
        await Promise.all(snap.docs.map((d) => fsCtx.fs.deleteDoc(d.ref)));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, COLLECTIONS.activityLogs);
      }
    }

    if (await isExpressBackendAvailable()) {
      await apiJson('/api/admin/clear-logs', {
        method: 'POST',
        headers: { 'x-admin-token': getStoredAdminToken() },
      });
    }

    const cfg = getActiveCloudConfig();
    if (cfg.mode === 'rtdb' && cfg.rtdbUrl) {
      await rtdbFetch('activityLogs', 'DELETE');
    }

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

function finalDocOverride(u) {
  return {
    lastLoginAt: u.lastLoginAt || '',
    loginCount: safeNum(u.loginCount),
    loginHistory: Array.isArray(u.loginHistory) ? u.loginHistory : [],
    balance: safeNum(u.balance),
    commission: safeNum(u.commission),
  };
}

if (typeof window !== 'undefined') {
  window.FirebaseStore = store;
  window.dispatchEvent(new CustomEvent('firebase-store-ready', { detail: store }));
}

export default store;
