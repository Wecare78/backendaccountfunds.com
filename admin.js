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
        color: '#00A9E0',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><defs><clipPath id="admSbiDiscClip"><circle cx="50" cy="50" r="41"/></clipPath></defs><g clip-path="url(#admSbiDiscClip)"><circle cx="50" cy="50" r="41" fill="#00B5EF"/><circle cx="50" cy="45.5" r="10.8" fill="#ffffff"/><rect x="46.2" y="53" width="7.6" height="40" fill="#ffffff"/></g></svg>`,
    },
    'hdfc': {
        name: 'HDFC Bank',
        shortCode: 'HDFCBK',
        color: '#004C8F',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="20" fill="#ffffff"/><rect x="13" y="13" width="74" height="74" fill="#ED232A"/><rect x="44" y="13" width="12" height="74" fill="#ffffff"/><rect x="13" y="44" width="74" height="12" fill="#ffffff"/><rect x="28" y="28" width="44" height="44" fill="#ffffff"/><rect x="36" y="36" width="28" height="28" fill="#004C8F"/></svg>`,
    },
    'icici': {
        name: 'ICICI Bank',
        shortCode: 'ICICIB',
        color: '#F37021',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><circle cx="50" cy="50" r="41" fill="#9A1B20"/><path d="M50 9A41 41 0 0 1 91 50H69A19 19 0 0 0 50 31V9Z" fill="#F37021"/><circle cx="53.5" cy="28.5" r="7.2" fill="#ffffff"/><path d="M39 43.5C45.5 41.2 54.5 41 58.2 44.8C59.2 46 58.2 49 56.5 53.8L50.8 69.5C49.6 72.8 52.8 74.2 57.5 71.2L59.5 76.2C52 81.2 40.5 80.5 39.2 72.5C38.6 68.8 40 64.2 42 59L45.8 48.8C44.2 48.2 41.2 48.6 38.2 49.6L39 43.5Z" fill="#ffffff"/></svg>`,
    },
    'axis': {
        name: 'Axis Bank',
        shortCode: 'AXISBK',
        color: '#97144D',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><path d="M50 14L14 84H35.5L50 54.5L64.5 84H86L50 14Z" fill="#97144D"/><path d="M50 54.5L64.5 84H43.5L50 54.5Z" fill="#6D0E36"/><path d="M40.5 64H59.5L55 54.5H45L40.5 64Z" fill="#ffffff"/></svg>`,
    },
    'kotak': {
        name: 'Kotak Mahindra Bank',
        shortCode: 'KOTAKB',
        color: '#ED1C24',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="9" y="9" width="82" height="82" rx="20" fill="#ED1C24"/><path d="M33.5 36.5C25.2 36.5 20 42.3 20 50C20 57.7 25.2 63.5 33.5 63.5C43 63.5 48.5 52.2 50 50C51.5 47.8 57 36.5 66.5 36.5C74.8 36.5 80 42.3 80 50C80 57.7 74.8 63.5 66.5 63.5C57 63.5 51.5 52.2 50 50C48.5 47.8 43 36.5 33.5 36.5Z" stroke="#ffffff" stroke-width="8.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="50" cy="50" r="5" fill="#003874"/></svg>`,
    },
    'pnb': {
        name: 'Punjab National Bank',
        shortCode: 'PNBSMS',
        color: '#A21D22',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="9" y="9" width="82" height="82" rx="20" fill="#A21D22"/><circle cx="50" cy="50" r="31" stroke="#FDB913" stroke-width="4.5"/><path d="M50 22C58 29 58 41 50 47C42 41 42 29 50 22Z" fill="#FDB913"/><path d="M25 63C34 59 44 63 48 72C37 74 28 70 25 63Z" fill="#FDB913"/><path d="M75 63C66 59 56 63 52 72C63 74 72 70 75 63Z" fill="#FDB913"/><circle cx="50" cy="53" r="6.5" fill="#ffffff"/></svg>`,
    },
    'baroda': {
        name: 'Bank of Baroda',
        shortCode: 'BOBSMS',
        color: '#F26522',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><path d="M21 31C35 20 65 20 79 31" stroke="#F26522" stroke-width="7.5" stroke-linecap="round"/><path d="M28 43C40 34 60 34 72 43" stroke="#F26522" stroke-width="6.5" stroke-linecap="round"/><path d="M21 53H44C47 53 48.5 55 48.5 58C48.5 60.5 47 62 44.5 62.5C47.5 63.2 49.5 65.2 49.5 68.5C49.5 72.5 46.5 75 41 75H21V53Z" fill="#F26522"/><path d="M79 53H56C53 53 51.5 55 51.5 58C51.5 60.5 53 62 55.5 62.5C52.5 63.2 50.5 65.2 50.5 68.5C50.5 72.5 53.5 75 59 75H79V53Z" fill="#F26522"/><rect x="19" y="81" width="62" height="5.5" rx="2.75" fill="#F26522"/></svg>`,
    },
    'canara': {
        name: 'Canara Bank',
        shortCode: 'CANRAB',
        color: '#009AD7',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><polygon points="50,13 85,48 67,66 50,49 33,66 15,48" fill="#009AD7"/><polygon points="50,87 83,54 67,38 50,55 33,38 17,54" fill="#FFD200"/><polygon points="50,41 59,50 50,59 41,50" fill="#ffffff"/></svg>`,
    },
    'union': {
        name: 'Union Bank of India',
        shortCode: 'UNIONB',
        color: '#E31E24',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><path d="M22 20V53C22 70 33 80 48 80C57 80 65 76 70 69L59 60C56 64 52 66 48 66C40 66 36 60 36 52V20H22Z" fill="#004B8D"/><path d="M78 80V47C78 30 67 20 52 20C43 20 35 24 30 31L41 40C44 36 48 34 52 34C60 34 64 40 64 48V80H78Z" fill="#E31E24"/></svg>`,
    },
    'bank of india': {
        name: 'Bank of India',
        shortCode: 'BKIDIN',
        color: '#F47920',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><polygon points="50,14 58.5,38.5 85,38.5 63.5,53.5 71.5,79 50,63.5 28.5,79 36.5,53.5 15,38.5 41.5,38.5" fill="#004C97"/><path d="M16 74C32 88 72 86 86 58C74 74 42 79 16 74Z" fill="#F47920"/><circle cx="50" cy="49" r="7.5" fill="#F47920"/></svg>`,
    },
    'idfc': {
        name: 'IDFC FIRST Bank',
        shortCode: 'IDFCFB',
        color: '#9D1D27',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="10" y="10" width="80" height="80" rx="18" fill="#9D1D27"/><rect x="25" y="25" width="50" height="10" rx="2" fill="#ffffff"/><rect x="25" y="25" width="11" height="50" rx="2" fill="#ffffff"/><rect x="44" y="45" width="31" height="10" rx="2" fill="#ffffff"/><rect x="44" y="45" width="11" height="30" rx="2" fill="#ffffff"/></svg>`,
    },
    'idbi': {
        name: 'IDBI Bank',
        shortCode: 'IDBIBK',
        color: '#007B4B',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><polygon points="50,14 82,32 82,68 50,86 18,68 18,32" fill="#007B4B"/><polygon points="50,24 72,37 50,50 28,37" fill="#F58220"/><polygon points="28,41 48,53 48,74 28,62" fill="#ffffff" fill-opacity="0.92"/><polygon points="72,41 52,53 52,74 72,62" fill="#ffffff" fill-opacity="0.72"/></svg>`,
    },
    'indian': {
        name: 'Indian Bank',
        shortCode: 'INDBNK',
        color: '#1A3B8B',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><circle cx="50" cy="50" r="38" fill="#1A3B8B"/><path d="M50 20C38 28 33 42 42 54C33 52 26 42 30 30C21 40 22 60 36 72H64C78 60 79 40 70 30C74 42 67 52 58 54C67 42 62 28 50 20Z" fill="#F47920"/><rect x="46" y="34" width="8" height="42" rx="4" fill="#ffffff"/></svg>`,
    },
    'indusind': {
        name: 'IndusInd Bank',
        shortCode: 'INDUSB',
        color: '#851B29',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="10" y="10" width="80" height="80" rx="18" fill="#851B29"/><path d="M24 68H76V76H24V68ZM30 36C36 27 44 25 52 28C59 31 66 28 70 23C71 31 68 38 62 42L66 61H56L53 48H43L40 61H30L33 45C28 43 26 40 30 36Z" fill="#FDB913"/></svg>`,
    },
    'yes': {
        name: 'YES Bank',
        shortCode: 'YESBNK',
        color: '#002F6C',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="10" y="10" width="80" height="80" rx="18" fill="#002F6C"/><path d="M22 50L41 70L80 28L71 22L41 55L29 42L22 50Z" fill="#ED1C24"/><path d="M46 72L82 35" stroke="#ffffff" stroke-width="5.5" stroke-linecap="round"/></svg>`,
    },
    'federal': {
        name: 'Federal Bank',
        shortCode: 'FEDBNK',
        color: '#004A98',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="10" y="10" width="80" height="80" rx="18" fill="#004A98"/><path d="M24 27H76L69 39H38V47H65L59 58H38V74H24V27Z" fill="#FDB913"/><rect x="52" y="64" width="24" height="10" rx="3" fill="#ffffff"/></svg>`,
    },
    'au small': {
        name: 'AU Small Finance Bank',
        shortCode: 'AUSFBK',
        color: '#5C2D91',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><path d="M16 74L44 20H56L84 74H68L61 60H39L32 74H16Z" fill="#5C2D91"/><polygon points="50,33 58,50 42,50" fill="#ffffff"/><path d="M22 76C38 86 62 86 78 76" stroke="#F37021" stroke-width="8" stroke-linecap="round"/></svg>`,
    },
    'rbl': {
        name: 'RBL Bank',
        shortCode: 'RBLBNK',
        color: '#1D428A',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><path d="M20 22H58C71 22 79 29 79 40C79 49 73 55 63 57L80 78H61L46 58H35V78H20V22Z" fill="#1D428A"/><circle cx="48" cy="40" r="9" fill="#E31837"/></svg>`,
    },
    'bandhan': {
        name: 'Bandhan Bank',
        shortCode: 'BANDHN',
        color: '#B5121B',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><path d="M50 16C62 30 63 43 50 54C37 43 38 30 50 16Z" fill="#FDB913"/><path d="M18 55C26 75 74 75 82 55H18Z" fill="#B5121B"/><path d="M26 76H74" stroke="#B5121B" stroke-width="6" stroke-linecap="round"/></svg>`,
    },
    'paytm': {
        name: 'Paytm Payments Bank',
        shortCode: 'PAYTMB',
        color: '#002E6E',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="8" y="25" width="84" height="50" rx="14" fill="#002E6E"/><rect x="48" y="25" width="44" height="50" rx="14" fill="#00BAF2"/><rect x="48" y="25" width="12" height="50" fill="#00BAF2"/><text x="29" y="57" font-size="21" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="Arial, sans-serif">Pay</text><text x="70" y="57" font-size="21" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="Arial, sans-serif">tm</text></svg>`,
    },
    'airtel': {
        name: 'Airtel Payments Bank',
        shortCode: 'AIRTEL',
        color: '#E40000',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="9" y="9" width="82" height="82" rx="20" fill="#E40000"/><path d="M64 29C47 22 28 33 27 51C26 65 36 74 49 72C62 70 72 58 74 43C61 40 48 46 44 55C41 62 46 67 52 63" stroke="#ffffff" stroke-width="9.5" stroke-linecap="round"/></svg>`,
    },
    'india post': {
        name: 'India Post Payments Bank',
        shortCode: 'IPPB',
        color: '#DA251C',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="9" y="9" width="82" height="82" rx="20" fill="#DA251C"/><polygon points="18,30 82,30 68,42 18,42" fill="#FDB913"/><polygon points="18,46 74,46 60,58 18,58" fill="#ffffff"/><polygon points="18,62 66,62 52,74 18,74" fill="#FDB913"/></svg>`,
    },
    'jio': {
        name: 'Jio Payments Bank',
        shortCode: 'JIOBNK',
        color: '#0A2885',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><circle cx="50" cy="50" r="41" fill="#0A2885"/><text x="50" y="61" font-size="34" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="Arial, sans-serif" letter-spacing="-1">Jio</text></svg>`,
    },
    'fino': {
        name: 'Fino Payments Bank',
        shortCode: 'FINOBK',
        color: '#0054A6',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><path d="M24 24H76V37H39V46H68V59H39V78H24V24Z" fill="#0054A6"/><circle cx="71" cy="70" r="9" fill="#E31E24"/></svg>`,
    },
    'equitas': {
        name: 'Equitas Small Finance Bank',
        shortCode: 'ESFB',
        color: '#1B365D',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><path d="M24 30H76V42H38V46H68V56H38V60H76V72H24V30Z" fill="#1B365D"/><circle cx="74" cy="24" r="7" fill="#84BD00"/></svg>`,
    },
    'ujjivan': {
        name: 'Ujjivan Small Finance Bank',
        shortCode: 'USFB',
        color: '#007C76',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><circle cx="50" cy="50" r="39" fill="#007C76"/><path d="M31 33V53C31 64 39 71 50 71C61 71 69 64 69 53V33H58V52C58 58 55 61 50 61C45 61 42 58 42 52V33H31Z" fill="#ffffff"/><circle cx="50" cy="25" r="5.5" fill="#F58220"/></svg>`,
    },
    'central': {
        name: 'Central Bank of India',
        shortCode: 'CBIN',
        color: '#A71930',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><path d="M76 34A33 33 0 1 0 76 66" stroke="#00529B" stroke-width="14" stroke-linecap="round"/><circle cx="54" cy="50" r="14" fill="#A71930"/></svg>`,
    },
    'overseas': {
        name: 'Indian Overseas Bank',
        shortCode: 'IOB',
        color: '#004E9E',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><circle cx="50" cy="50" r="38" fill="#004E9E"/><circle cx="50" cy="50" r="24" stroke="#FDB913" stroke-width="6"/><ellipse cx="50" cy="50" rx="11" ry="24" stroke="#ffffff" stroke-width="4.5"/><line x1="26" y1="50" x2="74" y2="50" stroke="#ffffff" stroke-width="4.5"/></svg>`,
    },
    'uco': {
        name: 'UCO Bank',
        shortCode: 'UCBA',
        color: '#0072BC',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><polygon points="50,12 88,50 50,88 12,50" fill="#0072BC"/><polygon points="50,24 76,50 50,76 24,50" fill="#FDB913"/><circle cx="50" cy="50" r="13" fill="#0072BC"/></svg>`,
    },
    'maharashtra': {
        name: 'Bank of Maharashtra',
        shortCode: 'MAHB',
        color: '#0066B3',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="10" y="10" width="80" height="80" rx="18" fill="#0066B3"/><path d="M22 72V28L50 51L78 28V72H64V48L50 60L36 48V72H22Z" fill="#ffffff"/></svg>`,
    },
    'punjab & sind': {
        name: 'Punjab & Sind Bank',
        shortCode: 'PSB',
        color: '#1A7348',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="10" y="10" width="80" height="80" rx="18" fill="#1A7348"/><circle cx="50" cy="50" r="24" stroke="#FDB913" stroke-width="7"/><polygon points="50,20 56,50 50,80 44,50" fill="#ffffff"/></svg>`,
    },
    'karnataka': {
        name: 'Karnataka Bank',
        shortCode: 'KARB',
        color: '#800040',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="10" y="10" width="80" height="80" rx="18" fill="#800040"/><path d="M29 24V76M29 50L65 24M39 45L69 76" stroke="#FDB913" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    },
    'south indian': {
        name: 'South Indian Bank',
        shortCode: 'SIB',
        color: '#A51C30',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="10" y="10" width="80" height="80" rx="18" fill="#A51C30"/><circle cx="50" cy="50" r="25" stroke="#ffffff" stroke-width="6.5"/><path d="M50 25V75M25 50H75" stroke="#FDB913" stroke-width="5.5"/></svg>`,
    },
    'karur': {
        name: 'Karur Vysya Bank',
        shortCode: 'KVB',
        color: '#006837',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="10" y="10" width="80" height="80" rx="18" fill="#006837"/><circle cx="50" cy="50" r="26" fill="#FDB913"/><path d="M35 50L50 32L65 50L50 68L35 50Z" fill="#006837"/></svg>`,
    },
    'hsbc': {
        name: 'HSBC Bank',
        shortCode: 'HSBC',
        color: '#DB0011',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><polygon points="30,24 70,24 50,50" fill="#DB0011"/><polygon points="30,76 70,76 50,50" fill="#DB0011"/><polygon points="10,50 30,24 30,76" fill="#DB0011"/><polygon points="90,50 70,24 70,76" fill="#DB0011"/></svg>`,
    },
    'standard chartered': {
        name: 'Standard Chartered Bank',
        shortCode: 'SCB',
        color: '#0072AA',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><path d="M63 22C46 22 36 35 48 46C61 57 52 74 36 78" stroke="#38D200" stroke-width="12" stroke-linecap="round"/><path d="M37 22C54 22 64 35 52 46C39 57 48 74 64 78" stroke="#0072AA" stroke-width="12" stroke-linecap="round"/></svg>`,
    },
    'citi': {
        name: 'Citibank India',
        shortCode: 'CITI',
        color: '#003B70',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><path d="M38 35C49 23 68 23 79 35" stroke="#EE1818" stroke-width="8.5" stroke-linecap="round"/><text x="50" y="68" font-size="32" font-weight="900" fill="#003B70" text-anchor="middle" font-family="Arial, sans-serif">citi</text></svg>`,
    },
    'dbs': {
        name: 'DBS Bank India',
        shortCode: 'DBSS',
        color: '#FF3333',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="10" y="10" width="80" height="80" rx="18" fill="#FF3333"/><polygon points="50,18 56,40 78,34 62,50 78,66 56,60 50,82 44,60 22,66 38,50 22,34 44,40" fill="#ffffff"/></svg>`,
    },
    'deutsche': {
        name: 'Deutsche Bank',
        shortCode: 'DEUT',
        color: '#0018A8',
        svg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><rect x="15" y="15" width="70" height="70" stroke="#0018A8" stroke-width="11"/><line x1="33" y1="67" x2="67" y2="33" stroke="#0018A8" stroke-width="11" stroke-linecap="square"/></svg>`,
    },
};

function svgToDataUrl(svgString) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(svgString.trim())}`;
}

function generateCustomBankLogo(cleanName, initials, hue) {
    const palettes = [
        ['#0F3D7A', '#0EA5E9'],
        ['#7C1D3A', '#F59E0B'],
        ['#0B5E4B', '#34D399'],
        ['#312E81', '#38BDF8'],
        ['#9A3412', '#FBBF24'],
        ['#1E3A8A', '#F43F5E'],
    ];
    const [primary, accent] = palettes[hue % palettes.length];
    return `<svg width="34" height="34" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="22" fill="#ffffff"/><path d="M50 10L84 23V50C84 71 69 84 50 90C31 84 16 71 16 50V23L50 10Z" fill="${primary}"/><path d="M50 18L76 28V49C76 66 64 76 50 81C36 76 24 66 24 49V28L50 18Z" stroke="${accent}" stroke-width="3" stroke-opacity="0.75"/><text x="50" y="59" font-size="25" font-weight="900" fill="#ffffff" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif" letter-spacing="1">${initials}</text></svg>`;
}

function getBankBrandInfo(rawBankName, customLogoUrl) {
    const raw = (rawBankName || '').trim();
    const name = raw.toLowerCase();

    const aliases = [
        ['bank of india', () => name.includes('bank of india') && !name.includes('state bank') && !name.includes('central bank') && !name.includes('union bank')],
        ['india post', () => name.includes('india post') || name.includes('ippb')],
        ['punjab & sind', () => name.includes('punjab & sind') || name.includes('punjab and sind')],
        ['au small', () => name.includes('au small') || name.includes('au bank')],
        ['south indian', () => name.includes('south indian')],
        ['standard chartered', () => name.includes('standard chartered')],
        ['overseas', () => name.includes('overseas') || name.includes('iob')],
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
        ['rbl', () => name.includes('rbl')],
        ['bandhan', () => name.includes('bandhan')],
        ['paytm', () => name.includes('paytm')],
        ['airtel', () => name.includes('airtel')],
        ['jio', () => name.includes('jio')],
        ['fino', () => name.includes('fino')],
        ['equitas', () => name.includes('equitas')],
        ['ujjivan', () => name.includes('ujjivan')],
        ['central', () => name.includes('central bank')],
        ['uco', () => name.includes('uco')],
        ['maharashtra', () => name.includes('maharashtra')],
        ['karnataka', () => name.includes('karnataka')],
        ['karur', () => name.includes('karur') || name.includes('kvb')],
        ['hsbc', () => name.includes('hsbc')],
        ['citi', () => name.includes('citi')],
        ['dbs', () => name.includes('dbs')],
        ['deutsche', () => name.includes('deutsche')],
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
