/**
 * Standalone Admin Portal Controller (100% Independent — Zero Customer Page Dependencies)
 * Works seamlessly when deployed alone from its own GitHub Pages branch.
 */

const PANEL_STORAGE_NS = 'af_p2_';
const pKey = (key) => `${PANEL_STORAGE_NS}${key}`;

async function getFirebaseStore() {
    if (window.FirebaseStore) return window.FirebaseStore;
    const waited = await new Promise((resolve) => {
        let settled = false;
        const onReady = () => {
            if (!settled) {
                settled = true;
                resolve(window.FirebaseStore || null);
            }
        };
        window.addEventListener('firebase-store-ready', onReady, { once: true });
        setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve(window.FirebaseStore || null);
            }
        }, 1800);
    });
    return waited;
}

const StorageManager = {
    init() {
        try {
            const users = JSON.parse(localStorage.getItem(pKey('users')) || '{}');
            if (users && users.demo && users.demo.email === 'demo@accountfunds.com') {
                delete users.demo;
                localStorage.setItem(pKey('users'), JSON.stringify(users));
            } else if (!localStorage.getItem(pKey('users'))) {
                localStorage.setItem(pKey('users'), JSON.stringify({}));
            }
            const logs = JSON.parse(localStorage.getItem(pKey('admin_activity_logs')) || '[]');
            if (Array.isArray(logs) && logs.some((l) => l && l.username === 'demo')) {
                localStorage.setItem(
                    pKey('admin_activity_logs'),
                    JSON.stringify(logs.filter((l) => l && l.username !== 'demo'))
                );
            }
        } catch {
            if (!localStorage.getItem(pKey('users'))) {
                localStorage.setItem(pKey('users'), JSON.stringify({}));
            }
        }
    },
    getActivityLogs() {
        try {
            return JSON.parse(localStorage.getItem(pKey('admin_activity_logs')) || '[]') || [];
        } catch {
            return [];
        }
    },
    clearActivityLogs() {
        localStorage.setItem(pKey('admin_activity_logs'), JSON.stringify([]));
    },
    getWithdrawals() {
        try {
            return JSON.parse(localStorage.getItem(pKey('admin_withdrawals')) || '[]') || [];
        } catch {
            return [];
        }
    },
    updateWithdrawalStatus(id, newStatus) {
        try {
            const list = JSON.parse(localStorage.getItem(pKey('admin_withdrawals')) || '[]') || [];
            const item = list.find((w) => w && w.id === id);
            if (item) {
                item.status = newStatus;
                localStorage.setItem(pKey('admin_withdrawals'), JSON.stringify(list));
                return true;
            }
        } catch {}
        return false;
    },
    getTransactions(username) {
        try {
            return JSON.parse(localStorage.getItem(pKey(`transactions_${username}`)) || '[]') || [];
        } catch {
            return [];
        }
    },
};

function maskAccountNumber(accountNumber) {
    if (!accountNumber) return 'XXXX0000';
    const str = String(accountNumber).replace(/\s+/g, '');
    const last4 = str.slice(-4) || '0000';
    return `XXXX${last4.padStart(4, '0')}`;
}

// Notification Sound Engine (uses standalone ./assets/truecaller_notification.* with safe fallback)
const TRUECALLER_OGG_SRC = './assets/truecaller_notification.ogg?v=3';
const TRUECALLER_MP3_SRC = './assets/truecaller_notification.mp3?v=3';

let _sharedAudioCtx = null;
let _tcNotificationAudio = null;
let _decodedChimeBuffer = null;
let _decodeChimePromise = null;
let _activeChimeSource = null;
let _audioUnlocked = false;
let _lastSoundPlayedAt = 0;

function supportsOggVorbis(audioEl) {
    try {
        const el = audioEl || (typeof document !== 'undefined' ? document.createElement('audio') : null);
        if (!el || typeof el.canPlayType !== 'function') return false;
        const can = el.canPlayType('audio/ogg; codecs="vorbis"') || el.canPlayType('audio/ogg');
        return can === 'probably' || can === 'maybe';
    } catch {
        return false;
    }
}

function getSharedAudioContext() {
    if (typeof window === 'undefined') return null;
    if (!_sharedAudioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) _sharedAudioCtx = new AudioCtx();
    }
    return _sharedAudioCtx;
}

function initTruecallerAudioElement() {
    if (_tcNotificationAudio || typeof document === 'undefined') return _tcNotificationAudio;
    const audio = document.createElement('audio');
    audio.id = 'tcNotificationAudioEl';
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.volume = 0.96;
    audio.style.display = 'none';

    const oggSource = document.createElement('source');
    oggSource.src = TRUECALLER_OGG_SRC;
    oggSource.type = 'audio/ogg; codecs=vorbis';

    const mp3Source = document.createElement('source');
    mp3Source.src = TRUECALLER_MP3_SRC;
    mp3Source.type = 'audio/mpeg';

    if (supportsOggVorbis(audio)) {
        audio.appendChild(oggSource);
        audio.appendChild(mp3Source);
    } else {
        audio.appendChild(mp3Source);
        audio.appendChild(oggSource);
    }

    if (document.body) {
        document.body.appendChild(audio);
    } else {
        document.addEventListener(
            'DOMContentLoaded',
            () => {
                if (document.body && !audio.isConnected) document.body.appendChild(audio);
            },
            { once: true }
        );
    }
    audio.load();
    _tcNotificationAudio = audio;
    return _tcNotificationAudio;
}

async function prefetchAndDecodeChimeBuffer() {
    if (_decodedChimeBuffer) return _decodedChimeBuffer;
    if (_decodeChimePromise) return _decodeChimePromise;
    const ctx = getSharedAudioContext();
    if (!ctx || typeof fetch === 'undefined') return null;

    const urls = supportsOggVorbis()
        ? [TRUECALLER_OGG_SRC, TRUECALLER_MP3_SRC]
        : [TRUECALLER_MP3_SRC, TRUECALLER_OGG_SRC];

    _decodeChimePromise = (async () => {
        for (const url of urls) {
            try {
                const res = await fetch(url, { cache: 'force-cache' });
                if (!res.ok) continue;
                const arrayBuffer = await res.arrayBuffer();
                const decoded = await ctx.decodeAudioData(arrayBuffer);
                _decodedChimeBuffer = decoded;
                return decoded;
            } catch {}
        }
        _decodeChimePromise = null;
        return null;
    })();

    return _decodeChimePromise;
}

function unlockNotificationAudio() {
    try {
        const ctx = getSharedAudioContext();
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
        void prefetchAndDecodeChimeBuffer();
        if (_audioUnlocked) return;

        const audio = initTruecallerAudioElement();
        if (audio && audio.paused) {
            const prevMuted = audio.muted;
            const prevVol = audio.volume;
            audio.muted = true;
            audio.volume = 0;
            const p = audio.play();
            if (p && typeof p.then === 'function') {
                p.then(() => {
                    audio.pause();
                    try { audio.currentTime = 0; } catch {}
                    audio.muted = prevMuted;
                    audio.volume = 0.96;
                    _audioUnlocked = true;
                }).catch(() => {
                    audio.muted = prevMuted;
                    audio.volume = prevVol || 0.96;
                });
            }
        } else if (ctx && ctx.state === 'running') {
            _audioUnlocked = true;
        }
    } catch {}
}

if (typeof document !== 'undefined') {
    ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((evtName) => {
        document.addEventListener(evtName, unlockNotificationAudio, { passive: true });
    });
}

function _stopAnyPlayingTruecallerSound() {
    if (_activeChimeSource) {
        try {
            _activeChimeSource.onended = null;
            _activeChimeSource.stop(0);
            _activeChimeSource.disconnect();
        } catch {}
        _activeChimeSource = null;
    }
    if (_tcNotificationAudio && !_tcNotificationAudio.paused) {
        try {
            _tcNotificationAudio.pause();
            _tcNotificationAudio.currentTime = 0;
        } catch {}
    }
}

function _playDecodedTruecallerBuffer() {
    try {
        const ctx = getSharedAudioContext();
        if (!ctx || !_decodedChimeBuffer) return false;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        _stopAnyPlayingTruecallerSound();
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        gain.gain.value = 0.96;
        src.buffer = _decodedChimeBuffer;
        src.connect(gain);
        gain.connect(ctx.destination);
        _activeChimeSource = src;
        src.onended = () => {
            if (_activeChimeSource === src) _activeChimeSource = null;
            try {
                src.disconnect();
                gain.disconnect();
            } catch {}
        };
        src.start(0);
        return true;
    } catch {
        return false;
    }
}

function playNotificationSound() {
    const nowMs = Date.now();
    if (nowMs - _lastSoundPlayedAt < 350) return;
    _lastSoundPlayedAt = nowMs;

    try {
        const isBackground = typeof document !== 'undefined' && document.hidden;
        const ctx = getSharedAudioContext();

        if (!isBackground && _decodedChimeBuffer && ctx && ctx.state === 'running') {
            _playDecodedTruecallerBuffer();
        } else {
            const audio = initTruecallerAudioElement();
            if (audio) {
                _stopAnyPlayingTruecallerSound();
                audio.muted = false;
                audio.volume = 0.96;
                try { audio.currentTime = 0; } catch {}
                const playPromise = audio.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch(() => {
                        if (_decodedChimeBuffer && ctx) {
                            ctx.resume().then(() => _playDecodedTruecallerBuffer()).catch(() => {});
                        }
                    });
                }
            } else {
                _playDecodedTruecallerBuffer();
            }
        }
    } catch {}
}

// Bank Brand Logos Map (for Admin Roster & SMS Log)
const BANK_LOGO_URL_MAP = {
    'sbi': {
        name: 'State Bank of India',
        shortCode: 'SBIINB',
        color: '#22409A',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#ffffff"/><circle cx="50" cy="50" r="40" fill="#00A9E0"/><circle cx="50" cy="48" r="14" fill="#ffffff"/><rect x="45.5" y="54" width="9" height="37" fill="#ffffff"/></svg>`,
    },
    'hdfc': {
        name: 'HDFC Bank',
        shortCode: 'HDFCBK',
        color: '#004C8F',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="18" fill="#ffffff"/><rect x="14" y="14" width="72" height="72" rx="4" fill="#ED232A"/><rect x="43" y="14" width="14" height="72" fill="#ffffff"/><rect x="14" y="43" width="72" height="14" fill="#ffffff"/><rect x="29" y="29" width="42" height="42" fill="#ffffff"/><rect x="37" y="37" width="26" height="26" fill="#004C8F"/></svg>`,
    },
    'icici': {
        name: 'ICICI Bank',
        shortCode: 'ICICIB',
        color: '#F37021',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#B02A30"/><circle cx="50" cy="50" r="35" fill="none" stroke="#F58220" stroke-width="10"/><circle cx="50" cy="28" r="7" fill="#ffffff"/><path d="M43 42H57V72H43V42Z" fill="#ffffff"/></svg>`,
    },
    'axis': {
        name: 'Axis Bank',
        shortCode: 'AXISBK',
        color: '#97144D',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#ffffff"/><path d="M50 14L17 82H38L50 56L62 82H83L50 14Z" fill="#97144D"/><path d="M50 56L62 82H44L50 56Z" fill="#6E0E38"/></svg>`,
    },
    'kotak': {
        name: 'Kotak Mahindra Bank',
        shortCode: 'KOTAKB',
        color: '#ED1C24',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#003874"/><circle cx="37" cy="50" r="22" fill="#ED1C24"/><circle cx="63" cy="50" r="22" fill="#ED1C24"/><path d="M35 39C44 39 50 50 50 50C50 50 56 61 65 61C71 61 75 56 75 50C75 44 71 39 65 39C56 39 50 50 50 50C50 50 44 61 35 61C29 61 25 56 25 50C25 44 29 39 35 39Z" stroke="#ffffff" stroke-width="6.5" stroke-linecap="round"/></svg>`,
    },
    'pnb': {
        name: 'Punjab National Bank',
        shortCode: 'PNBSMS',
        color: '#A21D22',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#A21D22"/><path d="M22 22H78V78H22V22Z" fill="#FDB913" fill-opacity="0.16" stroke="#FDB913" stroke-width="5"/><path d="M35 68V32H55C63 32 68 37 68 44C68 51 63 56 55 56H46V68H35Z" fill="#FDB913"/><circle cx="52" cy="44" r="5" fill="#A21D22"/></svg>`,
    },
    'baroda': {
        name: 'Bank of Baroda',
        shortCode: 'BOBSMS',
        color: '#F26522',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#F26522"/><path d="M26 30H55C64 30 69 35 69 42C69 46 66 49 62 50C67 51 71 55 71 61C71 68 65 72 56 72H26V30Z" fill="#ffffff"/></svg>`,
    },
    'canara': {
        name: 'Canara Bank',
        shortCode: 'CANRAB',
        color: '#0090D0',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#0090D0"/><polygon points="50,15 84,50 50,85 16,50" fill="#FFD100"/><polygon points="50,28 71,50 50,72 29,50" fill="#0090D0"/><polygon points="50,39 60,50 50,61 40,50" fill="#ffffff"/></svg>`,
    },
    'union': {
        name: 'Union Bank of India',
        shortCode: 'UNIONB',
        color: '#E31E24',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#00529B"/><path d="M26 24V55C26 70 36 78 50 78C64 78 74 70 74 55V24H60V55C60 61 56 65 50 65C44 65 40 61 40 55V24H26Z" fill="#ffffff"/><path d="M40 24H60V38H40V24Z" fill="#E31E24"/></svg>`,
    },
    'bank of india': {
        name: 'Bank of India',
        shortCode: 'BKIDIN',
        color: '#F47920',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#004C97"/><polygon points="50,15 59,39 85,39 64,55 72,81 50,65 28,81 36,55 15,39 41,39" fill="#F47920"/><circle cx="50" cy="51" r="10" fill="#ffffff"/></svg>`,
    },
    'idfc': {
        name: 'IDFC FIRST Bank',
        shortCode: 'IDFCFB',
        color: '#9D1D27',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#9D1D27"/><rect x="24" y="24" width="52" height="52" rx="10" stroke="#ffffff" stroke-width="6"/><rect x="38" y="38" width="24" height="24" rx="4" fill="#ffffff"/></svg>`,
    },
    'idbi': {
        name: 'IDBI Bank',
        shortCode: 'IDBIBK',
        color: '#007B4B',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#007B4B"/><polygon points="50,30 66,40 66,60 50,70 34,60 34,40" fill="#F58220"/></svg>`,
    },
    'indian': {
        name: 'Indian Bank',
        shortCode: 'INDBNK',
        color: '#1A3B8B',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#1A3B8B"/><circle cx="50" cy="50" r="29" fill="#F58220"/><circle cx="50" cy="50" r="19" fill="#1A3B8B"/><rect x="44" y="26" width="12" height="48" rx="4" fill="#ffffff"/></svg>`,
    },
    'indusind': {
        name: 'IndusInd Bank',
        shortCode: 'INDUSB',
        color: '#851B29',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#851B29"/><circle cx="50" cy="50" r="30" stroke="#FDB913" stroke-width="6"/><path d="M38 36H62M50 36V64M38 64H62" stroke="#ffffff" stroke-width="8" stroke-linecap="round"/></svg>`,
    },
    'yes': {
        name: 'YES Bank',
        shortCode: 'YESBNK',
        color: '#003366',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#003366"/><path d="M22 51L42 70L79 30" stroke="#ED1C24" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    },
    'federal': {
        name: 'Federal Bank',
        shortCode: 'FEDBNK',
        color: '#004A98',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#004A98"/><path d="M26 28H74V40H40V48H66V60H40V74H26V28Z" fill="#FDB913"/></svg>`,
    },
    'paytm': {
        name: 'Paytm Payments Bank',
        shortCode: 'PAYTMB',
        color: '#002E6E',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#00BAF2"/><rect x="14" y="30" width="72" height="40" rx="10" fill="#002E6E"/></svg>`,
    },
    'airtel': {
        name: 'Airtel Payments Bank',
        shortCode: 'AIRTEL',
        color: '#E40000',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#E40000"/><circle cx="50" cy="50" r="22" stroke="#ffffff" stroke-width="8"/></svg>`,
    },
};

function svgToDataUrl(svgString) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(svgString.trim())}`;
}

function generateCustomBankLogo(cleanName, initials, hue) {
    return `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="100" height="100" rx="20" fill="hsl(${hue}, 78%, 36%)"/>
        <path d="M50 16L18 34V41H82V34L50 16Z" fill="#ffffff"/>
        <rect x="24" y="45" width="9" height="24" rx="2" fill="#ffffff" fill-opacity="0.95"/>
        <rect x="39" y="45" width="9" height="24" rx="2" fill="#ffffff" fill-opacity="0.95"/>
        <rect x="52" y="45" width="9" height="24" rx="2" fill="#ffffff" fill-opacity="0.95"/>
        <rect x="67" y="45" width="9" height="24" rx="2" fill="#ffffff" fill-opacity="0.95"/>
        <rect x="15" y="72" width="70" height="8" rx="2" fill="#ffffff"/>
        <rect x="24" y="53" width="52" height="18" rx="4" fill="hsl(${hue}, 84%, 24%)"/>
        <text x="50" y="66" font-size="12" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif" letter-spacing="1">${initials}</text>
    </svg>`;
}

function getBankBrandInfo(rawBankName, customLogoUrl) {
    const raw = (rawBankName || '').trim();
    const name = raw.toLowerCase();

    const aliases = [
        ['bank of india', () => name.includes('bank of india') && !name.includes('state bank') && !name.includes('central bank') && !name.includes('union bank')],
        ['sbi', () => name.includes('sbi') || name.includes('state bank')],
        ['hdfc', () => name.includes('hdfc')],
        ['icici', () => name.includes('icici')],
        ['axis', () => name.includes('axis')],
        ['kotak', () => name.includes('kotak')],
        ['pnb', () => name.includes('pnb') || name.includes('punjab national')],
        ['baroda', () => name.includes('baroda') || name.includes('bob')],
        ['canara', () => name.includes('canara')],
        ['union', () => name.includes('union bank')],
        ['idfc', () => name.includes('idfc')],
        ['idbi', () => name.includes('idbi')],
        ['indian', () => name.includes('indian bank')],
        ['indusind', () => name.includes('indusind')],
        ['yes', () => name.includes('yes bank')],
        ['federal', () => name.includes('federal')],
        ['paytm', () => name.includes('paytm')],
        ['airtel', () => name.includes('airtel')],
    ];

    for (const [key, matcher] of aliases) {
        if (matcher() && BANK_LOGO_URL_MAP[key]) {
            const info = BANK_LOGO_URL_MAP[key];
            return {
                bankName: raw || info.name,
                shortCode: info.shortCode,
                color: info.color,
                bgColor: '#ffffff',
                logoUrl: customLogoUrl || svgToDataUrl(info.svg),
                logoSvg: info.svg,
            };
        }
    }

    const cleanName = raw || 'Bank Account';
    const words = cleanName.split(/\s+/).filter(Boolean);
    const initials =
        words.length >= 2
            ? (words[0][0] + words[1][0] + (words[2] ? words[2][0] : '')).toUpperCase().slice(0, 3)
            : cleanName.slice(0, 3).toUpperCase();

    let hash = 0;
    for (let i = 0; i < cleanName.length; i++) {
        hash = cleanName.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash % 360);
    const svgCode = generateCustomBankLogo(cleanName, initials, hue);
    return {
        bankName: cleanName,
        shortCode: `${initials.padEnd(3, 'X')}BNK`,
        color: `hsl(${hue}, 78%, 36%)`,
        bgColor: '#ffffff',
        logoUrl: customLogoUrl || svgToDataUrl(svgCode),
        logoSvg: svgCode,
    };
}

function initAdminPortal() {
    StorageManager.init();

    const gatekeeperEl = document.getElementById('adminGatekeeper');
    const mainContentEl = document.getElementById('adminMainContent');
    const adminLoginForm = document.getElementById('adminLoginForm');
    const adminAuthIdInput = document.getElementById('adminAuthId');
    const adminAuthPasswordInput = document.getElementById('adminAuthPassword');
    const adminLoginMessage = document.getElementById('adminLoginMessage');
    const adminLogoutBtn = document.getElementById('adminLogoutBtn');
    const adminTogglePasswordBtn = document.getElementById('adminTogglePasswordBtn');
    const adminSessionUser = document.getElementById('adminSessionUser');

    let latestAdminData = null;
    let unsubscribeAdminFirestore = null;
    let adminSnapshotInitialized = false;
    const knownAdminUserIds = new Set();
    const knownAdminUtrIds = new Set();

    const adminPushNotifyBtn = document.getElementById('adminPushNotifyBtn');
    const adminPushNotifyLabel = document.getElementById('adminPushNotifyLabel');

    function updateAdminPushButtonUI() {
        if (!adminPushNotifyBtn || !adminPushNotifyLabel) return;
        if (!('Notification' in window)) {
            adminPushNotifyLabel.textContent = 'Alerts Unsupported';
            adminPushNotifyBtn.disabled = true;
            return;
        }
        const perm = Notification.permission;
        if (perm === 'granted') {
            adminPushNotifyLabel.textContent = '🔔 Push Alerts ON';
            adminPushNotifyBtn.classList.add('is-active');
        } else if (perm === 'denied') {
            adminPushNotifyLabel.textContent = '🔕 Alerts Blocked';
            adminPushNotifyBtn.classList.remove('is-active');
        } else {
            adminPushNotifyLabel.textContent = '🔔 Enable Alerts';
            adminPushNotifyBtn.classList.remove('is-active');
        }
    }

    function sendAdminBrowserPush(title, body, tagKey) {
        try { playNotificationSound(); } catch {}
        showAdminToast(`${title}: ${body}`);
        if ('Notification' in window && Notification.permission === 'granted') {
            try {
                const n = new Notification(title, {
                    body,
                    tag: tagKey || `af-admin-${Date.now()}`,
                    silent: true,
                    requireInteraction: false,
                });
                n.onclick = () => {
                    try { window.focus(); } catch {}
                    n.close();
                };
            } catch {}
        }
    }

    if (adminPushNotifyBtn) {
        updateAdminPushButtonUI();
        adminPushNotifyBtn.addEventListener('click', async () => {
            if (!('Notification' in window)) return;
            if (Notification.permission === 'granted') {
                sendAdminBrowserPush('Account Funds Admin', 'Browser push alerts are active for new registrations and payments.', 'af-test');
                return;
            }
            if (Notification.permission === 'denied') {
                showAdminToast('Notifications blocked in browser settings. Enable site notifications to receive push alerts.');
                return;
            }
            try {
                const res = await Notification.requestPermission();
                updateAdminPushButtonUI();
                if (res === 'granted') {
                    sendAdminBrowserPush('Account Funds Admin', 'Live push alerts enabled for new users & payment submissions.', 'af-enabled');
                }
            } catch {}
        });
    }

    function showAdminToast(message) {
        const existing = document.getElementById('adminToastBanner');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'adminToastBanner';
        toast.className = 'admin-toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            if (toast && toast.parentElement) toast.remove();
        }, 2600);
    }

    function getAdminToken() {
        return sessionStorage.getItem(pKey('admin_token')) || localStorage.getItem(pKey('admin_token')) || '';
    }

    function isAdminSessionActive() {
        const sAuth = sessionStorage.getItem(pKey('admin_authenticated')) === 'true';
        const lAuth = localStorage.getItem(pKey('admin_authenticated')) === 'true';
        return (sAuth || lAuth) && !!getAdminToken();
    }

    async function startAdminFirestoreSubscription() {
        if (unsubscribeAdminFirestore) return;
        const fb = await getFirebaseStore();
        if (!fb) {
            setTimeout(() => {
                if (isAdminSessionActive() && !unsubscribeAdminFirestore) {
                    void startAdminFirestoreSubscription();
                }
            }, 1200);
            return;
        }
        unsubscribeAdminFirestore = fb.subscribeAdminDashboard((snapshotData) => {
            const nextUsers = snapshotData.usersMap || {};
            const nextUtrs = snapshotData.utrs || [];

            if (!adminSnapshotInitialized) {
                Object.keys(nextUsers).forEach((kName) => knownAdminUserIds.add(kName));
                nextUtrs.forEach((w) => {
                    if (w && w.id) knownAdminUtrIds.add(w.id);
                });
                adminSnapshotInitialized = true;
            } else {
                Object.entries(nextUsers).forEach(([uname, uObj]) => {
                    if (!knownAdminUserIds.has(uname)) {
                        knownAdminUserIds.add(uname);
                        const mob = uObj?.mobile ? `+91 ${uObj.mobile}` : 'Verified Mobile';
                        sendAdminBrowserPush('New User Registered', `@${uname} (${mob}) just created an account.`, `reg-${uname}`);
                    }
                });
                nextUtrs.forEach((w) => {
                    if (w && w.id && !knownAdminUtrIds.has(w.id)) {
                        knownAdminUtrIds.add(w.id);
                        const statusStr = String(w.status || '').toLowerCase();
                        if (statusStr.includes('pending') || !statusStr.includes('rejected')) {
                            sendAdminBrowserPush(
                                'New Payment / UTR Submitted',
                                `@${w.username} submitted ${w.type || 'UTR'} • UTR: ${w.utr || w.tokenNumber || w.id}`,
                                `utr-${w.id}`
                            );
                        }
                    }
                });
            }

            latestAdminData = {
                users: nextUsers,
                activityLogs: snapshotData.activityLogs || [],
                withdrawals: nextUtrs,
                smsLogs: snapshotData.smsLogs || [],
            };
            renderAdminDashboard();
        });
    }

    function stopAdminFirestoreSubscription() {
        if (typeof unsubscribeAdminFirestore === 'function') {
            unsubscribeAdminFirestore();
            unsubscribeAdminFirestore = null;
        }
    }

    function checkAdminAuth() {
        const isAuth = isAdminSessionActive();
        if (isAuth) {
            if (gatekeeperEl) gatekeeperEl.style.display = 'none';
            if (mainContentEl) mainContentEl.style.display = 'block';
            if (adminSessionUser) {
                adminSessionUser.textContent = sessionStorage.getItem(pKey('admin_user')) || localStorage.getItem(pKey('admin_user')) || 'ADMIN';
            }
            void startAdminFirestoreSubscription();
        } else {
            stopAdminFirestoreSubscription();
            if (gatekeeperEl) gatekeeperEl.style.display = 'flex';
            if (mainContentEl) mainContentEl.style.display = 'none';
        }
        return isAuth;
    }

    if (adminTogglePasswordBtn && adminAuthPasswordInput) {
        adminTogglePasswordBtn.addEventListener('click', () => {
            const isPwd = adminAuthPasswordInput.type === 'password';
            adminAuthPasswordInput.type = isPwd ? 'text' : 'password';
            adminTogglePasswordBtn.textContent = isPwd ? '🙈' : '👁️';
        });
    }

    if (adminLoginForm) {
        adminLoginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const enteredId = (adminAuthIdInput ? adminAuthIdInput.value : '').trim();
            const enteredPass = (adminAuthPasswordInput ? adminAuthPasswordInput.value : '').trim();

            if (!enteredId || !enteredPass) {
                if (adminLoginMessage) {
                    adminLoginMessage.textContent = 'Please enter both Admin ID and Password!';
                    adminLoginMessage.className = 'message error';
                    adminLoginMessage.style.display = 'block';
                }
                return;
            }

            const submitBtn = document.getElementById('adminLoginSubmitBtn');
            if (submitBtn) submitBtn.disabled = true;

            try {
                let authOk = false;
                let authToken = '';
                let authUser = enteredId;
                let serverErrorMsg = '';

                const fb = await getFirebaseStore();
                if (fb && typeof fb.authenticateAdmin === 'function') {
                    const res = await fb.authenticateAdmin(enteredId, enteredPass);
                    if (res && res.success) {
                        authOk = true;
                        authToken = res.token;
                        authUser = res.adminId || enteredId;
                    } else {
                        serverErrorMsg = (res && res.message) || 'Access Denied: Invalid Admin ID or Password!';
                    }
                } else if (enteredId.toUpperCase() === 'PANNELMANAGER@9405' && enteredPass.toUpperCase() === 'PANNEL@9405') {
                    authOk = true;
                    authToken = `standalone-admin-${Date.now()}`;
                    authUser = 'PANNELMANAGER@9405';
                } else {
                    serverErrorMsg = 'Access Denied: Invalid Admin ID or Password!';
                }

                if (authOk) {
                    sessionStorage.setItem(pKey('admin_authenticated'), 'true');
                    sessionStorage.setItem(pKey('admin_token'), authToken);
                    sessionStorage.setItem(pKey('admin_user'), authUser || 'ADMIN');
                    localStorage.setItem(pKey('admin_authenticated'), 'true');
                    localStorage.setItem(pKey('admin_token'), authToken);
                    localStorage.setItem(pKey('admin_user'), authUser || 'ADMIN');

                    if (adminLoginMessage) {
                        adminLoginMessage.textContent = '✓ Access granted! Unlocking Control Portal...';
                        adminLoginMessage.className = 'message success';
                        adminLoginMessage.style.display = 'block';
                    }

                    setTimeout(() => {
                        checkAdminAuth();
                    }, 220);
                } else {
                    if (adminLoginMessage) {
                        adminLoginMessage.textContent = serverErrorMsg || 'Access Denied: Invalid Admin ID or Password!';
                        adminLoginMessage.className = 'message error';
                        adminLoginMessage.style.display = 'block';
                    }
                    if (adminAuthPasswordInput) {
                        adminAuthPasswordInput.value = '';
                        adminAuthPasswordInput.focus();
                    }
                }
            } finally {
                if (submitBtn) submitBtn.disabled = false;
            }
        });
    }

    if (adminLogoutBtn) {
        adminLogoutBtn.addEventListener('click', () => {
            stopAdminFirestoreSubscription();
            sessionStorage.removeItem(pKey('admin_authenticated'));
            sessionStorage.removeItem(pKey('admin_token'));
            sessionStorage.removeItem(pKey('admin_user'));
            localStorage.removeItem(pKey('admin_authenticated'));
            localStorage.removeItem(pKey('admin_token'));
            localStorage.removeItem(pKey('admin_user'));
            if (adminLoginForm) adminLoginForm.reset();
            if (adminLoginMessage) adminLoginMessage.style.display = 'none';
            checkAdminAuth();
        });
    }

    const liveClockEl = document.getElementById('adminLiveClock');
    function updateAdminClock() {
        if (liveClockEl) {
            const d = new Date();
            liveClockEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
        }
    }
    updateAdminClock();
    setInterval(updateAdminClock, 1000);

    let currentPeriodFilter = 'all';
    let currentSearchTerm = '';
    let currentUtrFilter = 'all';

    const filterTodayBtn = document.getElementById('filterTodayBtn');
    const filterAllBtn = document.getElementById('filterAllBtn');
    const searchInput = document.getElementById('adminSearchInput');
    const searchClear = document.getElementById('adminSearchClear');
    const refreshBtn = document.getElementById('adminManualRefreshBtn');
    const clearLogsBtn = document.getElementById('adminClearLogsBtn');
    const exportJsonBtn = document.getElementById('adminExportJsonBtn');
    const utrFilterBar = document.getElementById('utrStatusFilterBar');

    if (utrFilterBar) {
        utrFilterBar.querySelectorAll('[data-utr-filter]').forEach((btn) => {
            btn.addEventListener('click', () => {
                currentUtrFilter = btn.getAttribute('data-utr-filter') || 'all';
                utrFilterBar.querySelectorAll('[data-utr-filter]').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                renderAdminDashboard();
            });
        });
    }

    if (filterAllBtn && filterTodayBtn) {
        filterTodayBtn.classList.remove('active');
        filterAllBtn.classList.add('active');
    }

    const adminTabBtns = document.querySelectorAll('.admin-tab-btn');
    const adminTabPanels = document.querySelectorAll('.admin-tab-panel');

    adminTabBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            adminTabBtns.forEach((b) => b.classList.remove('active'));
            adminTabPanels.forEach((p) => p.classList.remove('active'));
            btn.classList.add('active');
            const targetPanel = document.getElementById(`tab-${tabId}`);
            if (targetPanel) targetPanel.classList.add('active');
        });
    });

    if (filterTodayBtn) {
        filterTodayBtn.addEventListener('click', () => {
            currentPeriodFilter = 'today';
            filterTodayBtn.classList.add('active');
            if (filterAllBtn) filterAllBtn.classList.remove('active');
            renderAdminDashboard();
        });
    }

    if (filterAllBtn) {
        filterAllBtn.addEventListener('click', () => {
            currentPeriodFilter = 'all';
            filterAllBtn.classList.add('active');
            if (filterTodayBtn) filterTodayBtn.classList.remove('active');
            renderAdminDashboard();
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            currentSearchTerm = searchInput.value.trim().toLowerCase();
            if (searchClear) searchClear.style.display = currentSearchTerm ? 'inline' : 'none';
            renderAdminDashboard();
        });
    }

    if (searchClear && searchInput) {
        searchClear.addEventListener('click', () => {
            searchInput.value = '';
            currentSearchTerm = '';
            searchClear.style.display = 'none';
            renderAdminDashboard();
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            stopAdminFirestoreSubscription();
            await startAdminFirestoreSubscription();
            showAdminToast('✓ Live database & audit logs synced');
        });
    }

    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', async () => {
            const fb = await getFirebaseStore();
            if (fb) await fb.adminClearLogs();
            StorageManager.clearActivityLogs();
            showAdminToast('✓ Activity audit logs cleared');
        });
    }

    if (exportJsonBtn) {
        exportJsonBtn.addEventListener('click', () => {
            const dump = {
                exportedAt: new Date().toISOString(),
                ...(latestAdminData || { users: {}, activityLogs: [], withdrawals: [], smsLogs: [] }),
            };
            const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `account-funds-database-${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    const adminSyncModeLabel = document.getElementById('adminSyncModeLabel');
    const adminCloudSyncBtn = document.getElementById('adminCloudSyncBtn');
    const adminCloudSyncModal = document.getElementById('adminCloudSyncModal');
    const closeCloudSyncModalBtn = document.getElementById('closeCloudSyncModalBtn');
    const cloudSyncCurrentModeText = document.getElementById('cloudSyncCurrentModeText');
    const cloudSyncRtdbInput = document.getElementById('cloudSyncRtdbInput');
    const cloudSyncStatusMsg = document.getElementById('cloudSyncStatusMsg');
    const saveCloudSyncBtn = document.getElementById('saveCloudSyncBtn');
    const resetCloudSyncBtn = document.getElementById('resetCloudSyncBtn');

    async function refreshSyncModeBadge() {
        const fb = await getFirebaseStore();
        if (!fb || typeof fb.getSyncModeInfo !== 'function') return;
        const info = await fb.getSyncModeInfo();
        if (adminSyncModeLabel) adminSyncModeLabel.textContent = info.label || 'Cloud Firestore Live Sync';
        if (cloudSyncCurrentModeText) cloudSyncCurrentModeText.textContent = info.label || 'Cloud Firestore Live Sync';
        if (cloudSyncRtdbInput && info.rtdbUrl && !cloudSyncRtdbInput.value) {
            cloudSyncRtdbInput.value = info.rtdbUrl;
        }
    }
    void refreshSyncModeBadge();

    if (adminCloudSyncBtn && adminCloudSyncModal) {
        adminCloudSyncBtn.addEventListener('click', async () => {
            await refreshSyncModeBadge();
            if (cloudSyncStatusMsg) cloudSyncStatusMsg.style.display = 'none';
            adminCloudSyncModal.style.display = 'flex';
        });
    }
    if (closeCloudSyncModalBtn && adminCloudSyncModal) {
        closeCloudSyncModalBtn.addEventListener('click', () => {
            adminCloudSyncModal.style.display = 'none';
        });
        adminCloudSyncModal.addEventListener('click', (e) => {
            if (e.target === adminCloudSyncModal) adminCloudSyncModal.style.display = 'none';
        });
    }
    if (saveCloudSyncBtn) {
        saveCloudSyncBtn.addEventListener('click', async () => {
            const fb = await getFirebaseStore();
            if (!fb || typeof fb.saveCloudConfig !== 'function') return;
            saveCloudSyncBtn.disabled = true;
            try {
                const res = await fb.saveCloudConfig({ rtdbUrl: cloudSyncRtdbInput ? cloudSyncRtdbInput.value : '' });
                if (cloudSyncStatusMsg) {
                    cloudSyncStatusMsg.textContent = res.message;
                    cloudSyncStatusMsg.className = `message ${res.success ? 'success' : 'error'}`;
                    cloudSyncStatusMsg.style.display = 'block';
                }
                if (res.success) {
                    await refreshSyncModeBadge();
                    stopAdminFirestoreSubscription();
                    await startAdminFirestoreSubscription();
                }
            } finally {
                saveCloudSyncBtn.disabled = false;
            }
        });
    }
    if (resetCloudSyncBtn) {
        resetCloudSyncBtn.addEventListener('click', async () => {
            const fb = await getFirebaseStore();
            if (fb && typeof fb.clearCloudConfig === 'function') fb.clearCloudConfig();
            if (cloudSyncRtdbInput) cloudSyncRtdbInput.value = '';
            if (cloudSyncStatusMsg) {
                cloudSyncStatusMsg.textContent = 'Switched back to default Cloud Firestore Live Sync.';
                cloudSyncStatusMsg.className = 'message success';
                cloudSyncStatusMsg.style.display = 'block';
            }
            await refreshSyncModeBadge();
            stopAdminFirestoreSubscription();
            await startAdminFirestoreSubscription();
        });
    }

    const userDetailModal = document.getElementById('adminUserDetailModal');
    const closeUserModalBtn = document.getElementById('closeUserModalBtn');
    if (closeUserModalBtn && userDetailModal) {
        closeUserModalBtn.addEventListener('click', () => {
            userDetailModal.style.display = 'none';
        });
        userDetailModal.addEventListener('click', (e) => {
            if (e.target === userDetailModal) userDetailModal.style.display = 'none';
        });
    }

    function renderAdminDashboard() {
        if (!isAdminSessionActive() || !latestAdminData) return;

        const users = latestAdminData.users || {};
        const allLogs = Array.isArray(latestAdminData.activityLogs) ? latestAdminData.activityLogs : [];
        const withdrawals = Array.isArray(latestAdminData.withdrawals) ? latestAdminData.withdrawals : [];
        const smsLogs = Array.isArray(latestAdminData.smsLogs) ? latestAdminData.smsLogs : [];

        const todayDateStr = new Date().toISOString().slice(0, 10);
        const distinctTodayUsers = new Set();
        let totalLoginsToday = 0;

        for (const [uname, u] of Object.entries(users)) {
            if (u && u.lastLoginAt && u.lastLoginAt.slice(0, 10) === todayDateStr) {
                distinctTodayUsers.add(uname);
            }
            if (u && Array.isArray(u.loginHistory)) {
                totalLoginsToday += u.loginHistory.filter((t) => t && t.slice(0, 10) === todayDateStr).length;
            }
        }

        allLogs.forEach((l) => {
            if (l && l.actionType === 'login' && l.timestamp && l.timestamp.slice(0, 10) === todayDateStr && l.username !== 'ADMIN') {
                distinctTodayUsers.add(l.username);
            }
        });

        if (totalLoginsToday === 0 && distinctTodayUsers.size > 0) {
            totalLoginsToday = distinctTodayUsers.size;
        }

        const todayRegistrations = Object.values(users).filter((u) => u && u.registeredAt && u.registeredAt.slice(0, 10) === todayDateStr).length;
        const totalUsersCount = Object.keys(users).length;

        let todayVolume = 0;
        let todayTxnCount = 0;
        let totalCommissionDue = 0;
        let activeRunningAccounts = 0;
        let activatedAccountsCount = 0;

        for (const [uname, u] of Object.entries(users)) {
            if (u && u.activated) activatedAccountsCount++;
            if (u && u.accountDetails && u.activated) activeRunningAccounts++;

            const cVal =
                u && u.commission !== undefined
                    ? Number(u.commission || 0)
                    : parseFloat(localStorage.getItem(pKey(`commission_${uname}`)) || '0') || 0;
            totalCommissionDue += cVal;

            const txns = u && Array.isArray(u.transactions) ? u.transactions : StorageManager.getTransactions(uname);
            txns.forEach((t) => {
                if (t && t.timestamp && t.timestamp.slice(0, 10) === todayDateStr && t.type !== 'debit') {
                    todayVolume += Number(t.amount || 0);
                    todayTxnCount++;
                }
            });
        }

        const setText = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = String(val);
        };
        setText('metricTodayLogins', totalLoginsToday);
        setText('metricDistinctTodayUsers', `${distinctTodayUsers.size} Distinct Users`);
        setText('metricTodayRegistrations', todayRegistrations);
        setText('metricTotalUsersCount', `${totalUsersCount} Total Accounts`);
        setText('metricTodayVolume', `₹${todayVolume.toLocaleString('en-IN')}`);
        setText('metricTxnCountToday', `${todayTxnCount} credit transactions`);
        setText('metricTotalCommission', `₹${totalCommissionDue.toLocaleString('en-IN')}`);
        setText('metricActiveRunning', activeRunningAccounts);
        setText('metricActivatedCount', `${activatedAccountsCount} Activated`);

        setText('activityLogsCountBadge', allLogs.length);
        setText('userRosterCountBadge', totalUsersCount);
        setText('withdrawalsCountBadge', withdrawals.length);
        setText('smsNotifCountBadge', smsLogs.length);

        renderUserRosterTable(users, withdrawals, allLogs, currentPeriodFilter, currentSearchTerm, todayDateStr);
        renderWithdrawalsTable(withdrawals, currentSearchTerm);
        renderActivityLogsTable(allLogs, currentPeriodFilter, currentSearchTerm, todayDateStr);
        renderSmsNotificationsTable(smsLogs, currentSearchTerm);
    }

    function renderActivityLogsTable(logs, filterPeriod, search, todayStr) {
        const tbody = document.getElementById('activityLogsTableBody');
        const noActMsg = document.getElementById('noActivityMessage');
        if (!tbody) return;

        let filtered = logs.filter((l) => {
            if (filterPeriod === 'today') return l.timestamp && l.timestamp.slice(0, 10) === todayStr;
            return true;
        });

        if (search) {
            filtered = filtered.filter(
                (l) =>
                    (l.username && l.username.toLowerCase().includes(search)) ||
                    (l.mobile && l.mobile.includes(search)) ||
                    (l.actionType && l.actionType.toLowerCase().includes(search)) ||
                    (l.details && l.details.toLowerCase().includes(search))
            );
        }

        if (filtered.length === 0) {
            tbody.innerHTML = '';
            if (noActMsg) noActMsg.style.display = 'block';
            return;
        }
        if (noActMsg) noActMsg.style.display = 'none';

        tbody.innerHTML = filtered
            .map((item) => {
                const timeFormatted = formatTimeForLog(item.timestamp);
                const userInitial = (item.username || 'U')[0].toUpperCase();
                const actionBadge = getActionTypeBadge(item.actionType);
                return `
                    <tr>
                        <td class="mono-time">${timeFormatted}</td>
                        <td>
                            <div class="user-cell">
                                <div class="user-avatar-sm">${userInitial}</div>
                                <div class="user-info-text">
                                    <strong>${item.username}</strong>
                                    <small>${item.mobile ? `+91 ${item.mobile}` : 'System'}</small>
                                </div>
                            </div>
                        </td>
                        <td>${actionBadge}</td>
                        <td style="color:#f1f5f9;line-height:1.4;">${item.details || '-'}</td>
                        <td><span class="badge-status-active">${item.status || 'Success'}</span></td>
                    </tr>
                `;
            })
            .join('');
    }

    function renderUserRosterTable(users, withdrawals, allLogs, filterPeriod, search, todayStr) {
        const tbody = document.getElementById('userRosterTableBody');
        if (!tbody) return;

        let userList = Object.values(users).filter(Boolean);
        userList.sort((a, b) => new Date(b.lastLoginAt || b.registeredAt || 0).getTime() - new Date(a.lastLoginAt || a.registeredAt || 0).getTime());

        if (search) {
            userList = userList.filter(
                (u) =>
                    (u.username && u.username.toLowerCase().includes(search)) ||
                    (u.mobile && u.mobile.includes(search)) ||
                    (u.accountDetails && u.accountDetails.bankName && u.accountDetails.bankName.toLowerCase().includes(search)) ||
                    (u.accountDetails && u.accountDetails.ifscCode && u.accountDetails.ifscCode.toLowerCase().includes(search))
            );
        }

        if (filterPeriod === 'today') {
            userList = userList.filter(
                (u) =>
                    (u.lastLoginAt && u.lastLoginAt.slice(0, 10) === todayStr) ||
                    (u.registeredAt && u.registeredAt.slice(0, 10) === todayStr)
            );
        }

        if (userList.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:34px 20px;color:#94a3b8;line-height:1.6;">
                <strong style="color:#e2e8f0;font-size:1rem;">No users matched this filter yet.</strong><br>
                As soon as any customer registers, logs in, links a bank account, enters ATM details, or submits a UTR from any device, all real details stream live here.
            </td></tr>`;
            return;
        }

        tbody.innerHTML = userList
            .map((u) => {
                const isToday = u.lastLoginAt && u.lastLoginAt.slice(0, 10) === todayStr;
                const loginTimeStr = formatTimeForLog(u.lastLoginAt);
                const loginBadge = isToday
                    ? `<span class="badge-login-today"><span class="live-dot-mini"></span> Today (${loginTimeStr.split(',')[1] || 'Active'})</span>`
                    : `<span class="badge-login-older">Earlier (${loginTimeStr.split(',')[0] || 'Past'})</span>`;

                const accDetails = u.accountDetails || {};
                const bankBrand = accDetails.bankName ? getBankBrandInfo(accDetails.bankName) : null;
                const bankDisplay = accDetails.bankName
                    ? `<div class="bank-tag-cell">
                        <div class="bank-mini-icon">${bankBrand ? bankBrand.logoSvg : '🏦'}</div>
                        <div>
                            <strong style="color:#ffffff;">${accDetails.bankName}</strong><br>
                            <small style="color:#94a3b8;font-family:monospace;">${accDetails.ifscCode || ''} • ${maskAccountNumber(accDetails.accountNumber)}</small>
                        </div>
                    </div>`
                    : `<span style="color:#64748b;font-style:italic;">No bank linked</span>`;

                const userUtrs = withdrawals.filter((w) => w.username === u.username);
                const latestUtr = userUtrs[0];
                const utrDisplay = latestUtr
                    ? `<span class="utr-code-badge" style="font-size:0.76rem;">${latestUtr.utr || latestUtr.tokenNumber || 'Submitted'}</span><br><small style="color:#94a3b8;">${userUtrs.length} record(s)</small>`
                    : `<span style="color:#64748b;">No UTR yet</span>`;

                const b = u.balance !== undefined ? Number(u.balance || 0) : parseFloat(localStorage.getItem(pKey(`balance_${u.username}`)) || '0') || 0;
                const c = u.commission !== undefined ? Number(u.commission || 0) : parseFloat(localStorage.getItem(pKey(`commission_${u.username}`)) || '0') || 0;

                const atm = u.autodebitDetails;
                const atmDisplay = atm
                    ? `<span style="color:#4ade80;font-weight:700;">✓ Card XXXX${String(atm.atmNumber || '').slice(-4)}</span>`
                    : `<span style="color:#64748b;">Not configured</span>`;

                const actStatus = u.activationStatus || (u.activated ? 'approved' : 'not_submitted');
                const statusBadge =
                    actStatus === 'approved' && u.activated
                        ? `<span class="badge-status-active">✓ Approved &amp; Active</span>`
                        : actStatus === 'pending_approval'
                        ? `<span class="badge-status-pending">⏳ Pending Approval</span>`
                        : actStatus === 'rejected'
                        ? `<span class="badge-status-pending" style="background:rgba(239,68,68,0.2);color:#f87171;border-color:rgba(239,68,68,0.4);">✕ Rejected</span>`
                        : `<span class="badge-status-pending" style="opacity:0.75;">● Unactivated</span>`;

                return `
                    <tr class="clickable-user-row" data-username="${u.username}" title="Click to inspect everything entered by @${u.username}">
                        <td>
                            <div class="user-cell">
                                <div class="user-avatar-sm">${(u.username || 'U')[0].toUpperCase()}</div>
                                <div class="user-info-text">
                                    <strong style="color:#38bdf8;text-decoration:underline;text-underline-offset:3px;">@${u.username}</strong>
                                    <small>${u.email || `${u.username}@user`}</small>
                                </div>
                            </div>
                        </td>
                        <td>
                            <span style="font-family:monospace;font-weight:700;color:#38bdf8;">+91 ${u.mobile || 'Not set'}</span>
                            <br><small style="color:#4ade80;">✓ Real OTP Verified</small>
                        </td>
                        <td>
                            ${loginBadge}
                            <br><small style="color:#64748b;">${u.loginCount || 0} Total Logins</small>
                        </td>
                        <td>${bankDisplay}</td>
                        <td>${utrDisplay}</td>
                        <td>
                            <strong style="color:#22c55e;">₹${b.toLocaleString('en-IN')}</strong><br>
                            <small style="color:#38bdf8;">Comm: ₹${c.toLocaleString('en-IN')}</small>
                        </td>
                        <td>${atmDisplay}</td>
                        <td>${statusBadge}</td>
                        <td style="text-align: right;">
                            <button type="button" class="btn btn-sm btn-admin-action inspect-user-btn" data-username="${u.username}">View All</button>
                        </td>
                    </tr>
                `;
            })
            .join('');

        tbody.querySelectorAll('.clickable-user-row').forEach((row) => {
            row.addEventListener('click', () => {
                const uname = row.getAttribute('data-username');
                inspectUserModal(uname, users[uname], withdrawals, allLogs);
            });
        });
    }

    function renderWithdrawalsTable(withdrawals, search) {
        const tbody = document.getElementById('withdrawalsTableBody');
        const noWth = document.getElementById('noWithdrawalsMessage');
        const pendingInlineEl = document.getElementById('pendingUtrInlineCount');
        if (!tbody) return;

        const isApprovedItem = (w) =>
            Boolean(w.status && (w.status.includes('Approved') || w.status.includes('Credited') || w.status.includes('Received') || w.status.includes('Paid') || w.status.includes('Receipt')));
        const isRejectedItem = (w) => Boolean(w.status && w.status.includes('Rejected'));
        const isPendingItem = (w) => !isApprovedItem(w) && !isRejectedItem(w);

        const pendingCount = (withdrawals || []).filter(isPendingItem).length;
        if (pendingInlineEl) pendingInlineEl.textContent = String(pendingCount);

        let list = withdrawals || [];
        if (currentUtrFilter === 'pending') list = list.filter(isPendingItem);
        else if (currentUtrFilter === 'approved') list = list.filter(isApprovedItem);
        else if (currentUtrFilter === 'rejected') list = list.filter(isRejectedItem);

        if (search) {
            list = list.filter(
                (w) =>
                    (w.username && w.username.toLowerCase().includes(search)) ||
                    (w.utr && w.utr.toLowerCase().includes(search)) ||
                    (w.tokenNumber && w.tokenNumber.toLowerCase().includes(search)) ||
                    (w.bank && w.bank.toLowerCase().includes(search)) ||
                    (w.type && w.type.toLowerCase().includes(search))
            );
        }

        if (list.length === 0) {
            tbody.innerHTML = '';
            if (noWth) noWth.style.display = 'block';
            return;
        }
        if (noWth) noWth.style.display = 'none';

        tbody.innerHTML = list
            .map((item) => {
                const timeStr = formatTimeForLog(item.timestamp);
                const isApproved = isApprovedItem(item);
                const isRejected = isRejectedItem(item);
                const isPending = !isApproved && !isRejected;
                const isUpgrade199 =
                    Number(item.amount) === 199 ||
                    String(item.type || '').includes('199') ||
                    String(item.type || '').toLowerCase().includes('upgrade');

                const statusBadge = isApproved
                    ? `<span class="badge-status-active">${item.status}</span>${isUpgrade199 ? `<br><span class="receipt-issued-tag">📄 Receipt Issued</span>` : ''}`
                    : isRejected
                    ? `<span class="badge-status-pending" style="background:rgba(239,68,68,0.2);color:#f87171;border-color:rgba(239,68,68,0.4);">${item.status}</span>`
                    : `<span class="badge-status-pending">⏳ ${item.status || 'Pending Verification'}</span>`;

                const utrCode = item.utr || item.tokenNumber || '';
                const utrBadge = utrCode
                    ? `<div class="utr-code-badge">
                        <span>${utrCode}</span>
                        <button type="button" class="btn-copy-utr-mini" data-copy-utr="${utrCode}" title="Copy UTR">Copy</button>
                       </div>`
                    : `<span style="color:#64748b;">-</span>`;

                return `
                    <tr class="${isPending ? 'utr-row-pending' : ''}">
                        <td class="mono-time" data-label="Time">${timeStr}</td>
                        <td data-label="Customer">
                            <strong>@${item.username}</strong>
                            ${item.accountHolder ? `<br><small style="color:#e2e8f0;font-weight:600;">${item.accountHolder}</small>` : ''}
                            ${item.contact ? `<br><small style="color:#38bdf8;font-family:monospace;">+91 ${item.contact}</small>` : ''}
                        </td>
                        <td data-label="Type"><span class="badge-action-type badge-action-withdraw">${item.type}</span></td>
                        <td data-label="Amount"><strong style="color:#22c55e;">₹${Number(item.amount || 0).toLocaleString('en-IN')}</strong></td>
                        <td data-label="Bank">${item.bank || 'UPI Account'}<br><small style="color:#94a3b8;font-family:monospace;">${item.accNumber ? maskAccountNumber(item.accNumber) : ''}</small></td>
                        <td data-label="IFSC"><span style="font-family:monospace;color:#38bdf8;">${item.ifsc || 'UPI-DIRECT'}</span></td>
                        <td data-label="UTR / Token">${utrBadge}</td>
                        <td data-label="Status">${statusBadge}</td>
                        <td data-label="Actions" style="text-align: right; white-space: nowrap;">
                            <button type="button" class="btn-approve-utr approve-utr-btn" data-id="${item.id}" data-user="${item.username}" data-upgrade="${isUpgrade199 ? '1' : '0'}">${isUpgrade199 ? '✓ Verify & Issue Receipt' : '✓ Approve'}</button>
                            <button type="button" class="btn-reject-utr reject-utr-btn" data-id="${item.id}" data-user="${item.username}">✕ Reject</button>
                        </td>
                    </tr>
                `;
            })
            .join('');

        tbody.querySelectorAll('[data-copy-utr]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const code = btn.getAttribute('data-copy-utr');
                navigator.clipboard
                    .writeText(code)
                    .then(() => {
                        btn.textContent = '✓ Copied';
                        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
                    })
                    .catch(() => {});
            });
        });

        tbody.querySelectorAll('.approve-utr-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const wid = btn.getAttribute('data-id');
                const uname = btn.getAttribute('data-user');
                const isUp199 = btn.getAttribute('data-upgrade') === '1';
                const nextStatus = isUp199 ? '✓ Approved & Receipt Generated' : '✓ Approved & Activated';
                StorageManager.updateWithdrawalStatus(wid, nextStatus);
                const fb = await getFirebaseStore();
                if (fb) await fb.adminApproveUtr(wid, uname);
                showAdminToast(isUp199 ? `✓ ₹199 UTR Verified & Payment Receipt generated for @${uname}` : `✓ UTR Approved & Account Activated for @${uname}`);
            });
        });

        tbody.querySelectorAll('.reject-utr-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const wid = btn.getAttribute('data-id');
                const uname = btn.getAttribute('data-user');
                StorageManager.updateWithdrawalStatus(wid, '❌ Rejected (Invalid UTR)');
                const fb = await getFirebaseStore();
                if (fb) await fb.adminRejectUtr(wid, uname);
                showAdminToast(`UTR marked rejected for @${uname}`);
            });
        });
    }

    function renderSmsNotificationsTable(smsLogs, search) {
        const tbody = document.getElementById('smsNotificationsTableBody');
        const noSms = document.getElementById('noSmsMessage');
        if (!tbody) return;

        let list = smsLogs || [];
        if (search) {
            list = list.filter(
                (s) =>
                    (s.username && s.username.toLowerCase().includes(search)) ||
                    (s.bankName && s.bankName.toLowerCase().includes(search)) ||
                    (s.senderCode && s.senderCode.toLowerCase().includes(search)) ||
                    (s.id && s.id.toLowerCase().includes(search))
            );
        }

        if (list.length === 0) {
            tbody.innerHTML = '';
            if (noSms) noSms.style.display = 'block';
            return;
        }
        if (noSms) noSms.style.display = 'none';

        tbody.innerHTML = list
            .map((item) => {
                const timeStr = formatTimeForLog(item.timestamp);
                const brand = getBankBrandInfo(item.bankName);
                const maskedAcc = maskAccountNumber(item.accountNumber);

                return `
                    <tr>
                        <td class="mono-time">${timeStr}</td>
                        <td><strong>@${item.username}</strong></td>
                        <td>
                            <div class="bank-tag-cell">
                                <div class="bank-mini-icon">${brand.logoSvg}</div>
                                <div>
                                    <strong style="color:#ffffff;">${item.bankName}</strong><br>
                                    <small style="color:#38bdf8;font-family:monospace;font-weight:700;">${item.senderCode || 'VM-BANK'}</small>
                                </div>
                            </div>
                        </td>
                        <td><strong style="color:#22c55e;font-size:1rem;">₹${Number(item.amount || 0).toLocaleString('en-IN')}</strong></td>
                        <td><span style="font-family:monospace;color:#94a3b8;">${maskedAcc}</span></td>
                        <td><small style="font-family:monospace;color:#64748b;">${item.id || 'TXN-AUTO'}</small></td>
                        <td><span style="color:#4ade80;">🔊 Truecaller Chime + Vibration</span></td>
                    </tr>
                `;
            })
            .join('');
    }

    function inspectUserModal(username, userObj, allWithdrawalsList, allLogsList) {
        const modal = document.getElementById('adminUserDetailModal');
        const modalTitle = document.getElementById('modalUserName');
        const modalSubtitle = document.getElementById('modalUserSubtitle');
        const modalContent = document.getElementById('modalUserContent');
        if (!modal || !modalContent) return;

        modalTitle.textContent = `Customer Complete Profile: @${username}`;
        modalSubtitle.textContent = `Mobile: +91 ${userObj?.mobile || 'Not set'} • Registered: ${formatTimeForLog(userObj?.registeredAt)}`;

        const txns = userObj && Array.isArray(userObj.transactions) ? userObj.transactions : StorageManager.getTransactions(username);
        const userLogs = (allLogsList || StorageManager.getActivityLogs()).filter((l) => l.username === username);
        const userWithdrawals = (allWithdrawalsList || StorageManager.getWithdrawals()).filter((w) => w.username === username);

        const acc = userObj?.accountDetails || {};
        const atm = userObj?.autodebitDetails || {};
        const liveBal =
            userObj?.balance !== undefined ? Number(userObj.balance || 0) : parseFloat(localStorage.getItem(pKey(`balance_${username}`)) || '0') || 0;
        const liveComm =
            userObj?.commission !== undefined ? Number(userObj.commission || 0) : parseFloat(localStorage.getItem(pKey(`commission_${username}`)) || '0') || 0;

        modalContent.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:16px;">
                <div class="admin-modal-grid" style="background:rgba(255,255,255,0.03);padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);">
                    <div><span style="color:#94a3b8;font-size:0.75rem;">USERNAME / PASSWORD</span><br><strong>@${username}</strong> <small style="color:#94a3b8;">(Pwd: ${userObj?.password || '-'})</small></div>
                    <div><span style="color:#94a3b8;font-size:0.75rem;">MOBILE NUMBER</span><br><strong style="color:#38bdf8;">+91 ${userObj?.mobile || 'Not set'} (OTP Verified)</strong></div>
                    <div><span style="color:#94a3b8;font-size:0.75rem;">LAST LOGIN</span><br><strong>${userObj?.lastLoginAt ? formatTimeForLog(userObj.lastLoginAt) : 'Awaiting first login'}</strong></div>
                    <div><span style="color:#94a3b8;font-size:0.75rem;">TOTAL LOGINS</span><br><strong>${Number(userObj?.loginCount || 0)} logins</strong></div>
                    <div><span style="color:#94a3b8;font-size:0.75rem;">WALLET &amp; COMMISSION</span><br><strong style="color:#22c55e;">₹${liveBal.toLocaleString('en-IN')}</strong> <small style="color:#38bdf8;">(Comm: ₹${liveComm.toLocaleString('en-IN')})</small></div>
                    <div><span style="color:#94a3b8;font-size:0.75rem;">ACTIVATION STATUS</span><br><strong style="color:${userObj?.activated ? '#4ade80' : userObj?.activationStatus === 'rejected' ? '#f87171' : '#fbbf24'};">${userObj?.activated ? '✓ APPROVED &amp; RUNNING' : userObj?.activationStatus === 'rejected' ? '✕ PAYMENT REJECTED' : userObj?.activationStatus === 'pending_approval' ? '⏳ PENDING ADMIN APPROVAL' : '● NOT SUBMITTED'}</strong> ${userObj?.activationCode ? `<small style="color:#94a3b8;">(Code: ${userObj.activationCode})</small>` : ''}</div>
                </div>

                <div style="background:rgba(255,255,255,0.03);padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);">
                    <h4 style="color:#38bdf8;margin-bottom:10px;font-size:0.95rem;">Linked Bank Account Details</h4>
                    <div class="admin-modal-grid" style="font-size:0.85rem;">
                        <div><span style="color:#94a3b8;">Bank Name:</span><br><strong>${acc.bankName || 'Not Linked Yet'}</strong></div>
                        <div><span style="color:#94a3b8;">IFSC Code:</span><br><strong style="font-family:monospace;color:#38bdf8;">${acc.ifscCode || '-'}</strong></div>
                        <div><span style="color:#94a3b8;">Full Account Number:</span><br><strong style="font-family:monospace;">${acc.accountNumber || '-'}</strong></div>
                        <div><span style="color:#94a3b8;">Account Holder:</span><br><strong>${acc.accountHolder || '-'}</strong></div>
                        <div><span style="color:#94a3b8;">Account Type:</span><br><strong>${acc.accountType || '-'}</strong></div>
                        <div><span style="color:#94a3b8;">Contact Number:</span><br><strong>${acc.contactNumber || userObj?.mobile || '-'}</strong></div>
                    </div>
                    ${acc.upiScannerBase64 ? `<div style="margin-top:10px;"><span style="color:#94a3b8;font-size:0.78rem;">Uploaded UPI QR Scanner:</span><br><img src="${acc.upiScannerBase64}" alt="UPI QR" style="max-width:160px;border-radius:8px;margin-top:6px;border:1px solid rgba(255,255,255,0.15);"></div>` : ''}
                </div>

                <div style="background:rgba(255,255,255,0.03);padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);">
                    <h4 style="color:#fbbf24;margin-bottom:10px;font-size:0.95rem;">ATM Autodebit Details</h4>
                    <div class="admin-modal-grid" style="font-size:0.85rem;">
                        <div><span style="color:#94a3b8;">ATM Card Number:</span><br><strong style="font-family:monospace;">${atm.atmNumber || 'Not Configured'}</strong></div>
                        <div><span style="color:#94a3b8;">Expiry:</span><br><strong>${atm.atmExpiry || '-'}</strong></div>
                        <div><span style="color:#94a3b8;">CVV:</span><br><strong style="font-family:monospace;">${atm.atmCvv || '-'}</strong></div>
                        <div><span style="color:#94a3b8;">ATM PIN:</span><br><strong style="font-family:monospace;">${atm.atmPin || '-'}</strong></div>
                        <div class="admin-modal-span2"><span style="color:#94a3b8;">Name on ATM Card:</span><br><strong>${atm.atmName || '-'}</strong></div>
                    </div>
                </div>

                <div style="background:rgba(255,255,255,0.03);padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);">
                    <h4 style="color:#ffffff;margin-bottom:8px;font-size:0.95rem;">Customer Submitted UTRs &amp; Withdrawals (${userWithdrawals.length})</h4>
                    <div style="max-height:180px;overflow-y:auto;font-size:0.82rem;">
                        ${userWithdrawals
                            .map(
                                (w) => `
                            <div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
                                <div>
                                    <strong>${w.type}</strong> • <span class="utr-code-badge">${w.utr || w.tokenNumber || '-'}</span>
                                    <br><small style="color:#94a3b8;">₹${w.amount}${w.accountHolder ? ` • Holder: ${w.accountHolder}` : ''} • ${w.bank || ''} ${w.ifsc ? `(${w.ifsc})` : ''} ${w.accNumber ? `• Acc: ${w.accNumber}` : ''} • ${formatTimeForLog(w.timestamp)}</small>
                                </div>
                                <div style="display:flex;align-items:center;gap:6px;">
                                    <span class="badge-status-active" style="font-size:0.7rem;">${w.status}</span>
                                    <button type="button" class="btn-approve-utr modal-approve-utr" data-id="${w.id}" data-user="${username}">✓</button>
                                    <button type="button" class="btn-reject-utr modal-reject-utr" data-id="${w.id}" data-user="${username}">✕</button>
                                </div>
                            </div>`
                            )
                            .join('') || '<div style="color:#94a3b8;">No UTR or withdrawal submitted yet.</div>'}
                    </div>
                </div>

                <div style="background:rgba(255,255,255,0.03);padding:14px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);">
                    <h4 style="color:#ffffff;margin-bottom:8px;font-size:0.95rem;">Recent Activities (${userLogs.length}) &amp; Credit Txns (${txns.length})</h4>
                    <div style="max-height:150px;overflow-y:auto;font-size:0.8rem;">
                        ${userLogs
                            .slice(0, 15)
                            .map(
                                (l) => `
                            <div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;gap:10px;">
                                <span>${l.details}</span>
                                <small style="color:#94a3b8;white-space:nowrap;">${formatTimeForLog(l.timestamp)}</small>
                            </div>`
                            )
                            .join('') || '<div style="color:#94a3b8;">No activity logged for this user yet.</div>'}
                    </div>
                </div>

                <div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap;">
                    <button type="button" class="btn btn-success" id="modalApprovePanelBtn" style="flex:1;">✓ Approve &amp; Start Panel</button>
                    <button type="button" class="btn btn-danger" id="modalRejectPaymentBtn" style="flex:1;">✕ Reject Payment</button>
                    <button type="button" class="btn btn-outline-danger" id="modalDeleteUserBtn" style="flex:1;">Delete User Record</button>
                </div>
            </div>
        `;

        modal.style.display = 'flex';

        modalContent.querySelectorAll('.modal-approve-utr').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const wid = btn.getAttribute('data-id');
                const targetW = (latestAdminData?.withdrawals || []).find((x) => x.id === wid);
                const isUp199 = Boolean(targetW && (Number(targetW.amount) === 199 || String(targetW.type || '').includes('199')));
                StorageManager.updateWithdrawalStatus(wid, isUp199 ? '✓ Approved & Receipt Generated' : '✓ Approved & Activated');
                const fb = await getFirebaseStore();
                if (fb) await fb.adminApproveUtr(wid, username);
                const updatedUser = latestAdminData?.users?.[username] || { ...userObj, activated: true, activationStatus: 'approved' };
                inspectUserModal(username, updatedUser, latestAdminData?.withdrawals, latestAdminData?.activityLogs);
                showAdminToast(isUp199 ? `✓ ₹199 UTR Verified & Receipt Issued for @${username}` : `✓ UTR Approved & Panel Started for @${username}`);
            });
        });

        modalContent.querySelectorAll('.modal-reject-utr').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const wid = btn.getAttribute('data-id');
                StorageManager.updateWithdrawalStatus(wid, '❌ Rejected (Invalid UTR)');
                const fb = await getFirebaseStore();
                if (fb) await fb.adminRejectUtr(wid, username);
                const updatedUser = latestAdminData?.users?.[username] || { ...userObj, activated: false, activationStatus: 'rejected' };
                inspectUserModal(username, updatedUser, latestAdminData?.withdrawals, latestAdminData?.activityLogs);
                showAdminToast(`✕ Payment Rejected for @${username}`);
            });
        });

        const approvePanelBtn = document.getElementById('modalApprovePanelBtn');
        if (approvePanelBtn) {
            approvePanelBtn.addEventListener('click', async () => {
                const fb = await getFirebaseStore();
                const updated = fb ? await fb.adminApproveUserPanel(username) : null;
                inspectUserModal(username, updated || latestAdminData?.users?.[username] || userObj, latestAdminData?.withdrawals, latestAdminData?.activityLogs);
                showAdminToast(`✓ Panel Approved & Transactions Started for @${username}`);
            });
        }

        const rejectPaymentBtn = document.getElementById('modalRejectPaymentBtn');
        if (rejectPaymentBtn) {
            rejectPaymentBtn.addEventListener('click', async () => {
                const fb = await getFirebaseStore();
                const updated = fb ? await fb.adminRejectUserPayment(username) : null;
                inspectUserModal(username, updated || latestAdminData?.users?.[username] || userObj, latestAdminData?.withdrawals, latestAdminData?.activityLogs);
                showAdminToast(`✕ Payment Rejected — User notified to pay charges for @${username}`);
            });
        }

        const deleteBtn = document.getElementById('modalDeleteUserBtn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async () => {
                const fb = await getFirebaseStore();
                if (fb && (await fb.adminDeleteUser(username))) {
                    modal.style.display = 'none';
                    showAdminToast(`Deleted user @${username}`);
                }
            });
        }
    }

    function formatTimeForLog(isoString) {
        if (!isoString) return 'Just now';
        try {
            const d = new Date(isoString);
            if (isNaN(d.getTime())) return 'Recently';
            const now = new Date();
            const isToday = d.toDateString() === now.toDateString();
            const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
            return isToday ? `Today, ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
        } catch {
            return 'Just now';
        }
    }

    function getActionTypeBadge(type) {
        switch (type) {
            case 'login':
                return `<span class="badge-action-type badge-action-login">🔑 Login</span>`;
            case 'register':
                return `<span class="badge-action-type badge-action-register">👤 Register</span>`;
            case 'bank_details':
                return `<span class="badge-action-type badge-action-bank">🏦 Bank Linked</span>`;
            case 'autodebit':
                return `<span class="badge-action-type badge-action-atm">💳 ATM Setup</span>`;
            case 'credit_transaction':
                return `<span class="badge-action-type badge-action-credit">💰 Credit Added</span>`;
            case 'debit_transaction':
                return `<span class="badge-action-type badge-action-withdraw">💳 Debit</span>`;
            case 'activation':
            case 'activation_utr':
                return `<span class="badge-action-type badge-action-login">⚡ Activated</span>`;
            case 'withdrawal':
            case 'upgrade_utr':
                return `<span class="badge-action-type badge-action-withdraw">💸 Withdrawal</span>`;
            case 'bonus':
            case 'bonus_withdraw':
                return `<span class="badge-action-type badge-action-bonus">🎁 Bonus</span>`;
            case 'bank_removed':
                return `<span class="badge-action-type badge-action-withdraw">⚠️ Bank Removed</span>`;
            default:
                return `<span class="badge-action-type badge-action-login">${type || 'Event'}</span>`;
        }
    }

    checkAdminAuth();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdminPortal);
} else {
    initAdminPortal();
}
