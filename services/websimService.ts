import { LeaderboardEntry, ReplayData, UserProgress, GameSettings } from '../types';
import { compressReplay, decompressReplay } from './replayCompression';

export function getWebsimObject(): any {
    if (typeof window === 'undefined') return null;
    const win = window as any;
    if (win.websim) return win.websim;
    try {
        if (win.parent && win.parent !== win && win.parent.websim) {
            return win.parent.websim;
        }
    } catch (e) {
        // Cross-origin iframe restriction
    }
    try {
        if (win.top && win.top !== win && win.top.websim) {
            return win.top.websim;
        }
    } catch (e) {
        // Cross-origin iframe restriction
    }
    return null;
}

export const isWebsim = (): boolean => {
    if (typeof window === 'undefined') return false;
    if (getWebsimObject()) return true;
    const host = window.location.hostname || '';
    const href = window.location.href || '';
    return host.includes('websim.ai') || host.includes('websim.com') || host.includes('websim.app') || host.includes('websim.page') || host.includes('websim.site') || href.includes('websim');
};

function getFallbackWebsimUser() {
    let localId = localStorage.getItem('astra_websim_guest_id');
    if (!localId) {
        localId = 'pilot_' + Math.random().toString(36).substring(2, 11);
        localStorage.setItem('astra_websim_guest_id', localId);
    }
    return {
        id: localId,
        username: 'PILOT_' + localId.slice(-4).toUpperCase(),
        avatar_url: ''
    };
}

export async function getWebsimUser() {
    const w = getWebsimObject();
    if (w) {
        if (typeof w.getUser === 'function') {
            try {
                const user = await w.getUser();
                if (user && user.id) return user;
            } catch (e) {
                console.error("[Websim] Error in w.getUser():", e);
            }
        }
        if (typeof w.getCurrentUser === 'function') {
            try {
                const user = await w.getCurrentUser();
                if (user && user.id) return user;
            } catch (e) {
                console.error("[Websim] Error in w.getCurrentUser():", e);
            }
        }
    }
    return getFallbackWebsimUser();
}

export function getWebsimSiteId(w?: any): string | null {
    if (typeof window === 'undefined') return null;
    const websimObj = w || getWebsimObject();
    if (websimObj) {
        if (websimObj.siteId) return String(websimObj.siteId);
        if (websimObj.site_id) return String(websimObj.site_id);
        if (typeof websimObj.getSiteId === 'function') {
            try { const id = websimObj.getSiteId(); if (id) return String(id); } catch (e) { }
        }
        if (typeof websimObj.getCreatedSite === 'function') {
            try { const s = websimObj.getCreatedSite(); if (s && s.id) return String(s.id); } catch (e) { }
        }
    }

    const host = window.location.hostname || '';
    // E.g. dnql3rgc00mwqp3r7gw2.c.websim.com -> dnql3rgc00mwqp3r7gw2
    const subMatch = host.match(/^([a-zA-Z0-9_-]+)\.(?:c\.)?websim\.(?:com|ai|page|app)/i);
    if (subMatch && subMatch[1] && subMatch[1] !== 'www' && subMatch[1] !== 'app' && subMatch[1] !== 'api') {
        return subMatch[1];
    }

    const match = window.location.pathname.match(/\/sites\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];

    return null;
}

export async function resolveWebsimSiteId(w?: any): Promise<string | null> {
    const syncId = getWebsimSiteId(w);
    if (syncId) return syncId;

    const websimObj = w || getWebsimObject();
    if (websimObj && typeof websimObj.getCurrentProject === 'function') {
        try {
            const proj = await websimObj.getCurrentProject();
            if (proj) {
                if (proj.id) return String(proj.id);
                if (proj.site_id) return String(proj.site_id);
                if (proj.project_id) return String(proj.project_id);
                if (proj.slug) return String(proj.slug);
            }
        } catch (e) { }
    }

    if (websimObj && typeof websimObj.getBootstrap === 'function') {
        try {
            const boot = await websimObj.getBootstrap();
            if (boot) {
                if (boot.siteId) return String(boot.siteId);
                if (boot.site?.id) return String(boot.site.id);
                if (boot.project?.id) return String(boot.project.id);
            }
        } catch (e) { }
    }

    return null;
}

function asTemplateStringsArray(query: string): TemplateStringsArray {
    const arr = [query] as unknown as TemplateStringsArray;
    Object.defineProperty(arr, 'raw', {
        value: Object.freeze([query]),
        writable: false,
        configurable: false
    });
    return Object.freeze(arr) as TemplateStringsArray;
}

export interface DbAttemptRecord {
    method: string;
    status: 'success' | 'failed' | 'skipped';
    error?: string;
    details?: string;
}

function dumpObject(obj: any, maxDepth = 2): any {
    if (obj === null || obj === undefined) return String(obj);
    if (typeof obj !== 'object' && typeof obj !== 'function') return typeof obj;
    const res: any = { _type: typeof obj };
    if (typeof obj === 'function') {
        res._isFunction = true;
        res._name = obj.name || 'anonymous';
    }
    const propNames = Array.from(new Set([
        ...Object.keys(obj),
        ...Object.getOwnPropertyNames(obj)
    ]));
    for (const key of propNames.slice(0, 40)) {
        if (key === 'constructor' || key === '__proto__' || key === 'prototype') continue;
        try {
            const val = obj[key];
            if (typeof val === 'function') {
                res[key] = `function(${val.length} args)`;
            } else if (val && typeof val === 'object' && maxDepth > 1) {
                res[key] = dumpObject(val, maxDepth - 1);
            } else {
                res[key] = String(val).slice(0, 80);
            }
        } catch (e: any) {
            res[key] = `error: ${e?.message}`;
        }
    }
    return res;
}

/**
 * Recursively discovers candidate database/SQL/collection functions across websim and window.
 */
function findDatabaseFunctions(w: any): { name: string; target: any; fn: Function }[] {
    const found: { name: string; target: any; fn: Function }[] = [];
    const visited = new Set<any>();

    function inspect(obj: any, path: string, depth = 0) {
        if (!obj || depth > 3 || visited.has(obj)) return;
        visited.add(obj);

        if (typeof obj === 'function') {
            if (/sql|query|sqlite|exec/i.test(path) && !/getUser|getCreator|getBootstrap|getColorScheme|getComments|addEventListener/i.test(path)) {
                found.push({ name: path, target: null, fn: obj });
            }
        }

        const props = Array.from(new Set([
            ...Object.keys(obj),
            ...Object.getOwnPropertyNames(obj)
        ]));

        for (const prop of props) {
            if (prop === 'constructor' || prop === '__proto__' || prop === 'prototype') continue;
            try {
                const val = obj[prop];
                const childPath = `${path}.${prop}`;
                if (typeof val === 'function') {
                    if (/sql|query|sqlite|exec/i.test(prop) && !/getUser|getCreator|getBootstrap|getColorScheme|getComments|addEventListener/i.test(prop)) {
                        found.push({ name: childPath, target: obj, fn: val });
                    }
                } else if (val && typeof val === 'object') {
                    inspect(val, childPath, depth + 1);
                }
            } catch (e) { }
        }
    }

    if (w) {
        inspect(w, 'websim');
        if (w.experimental) inspect(w.experimental, 'websim.experimental');
        if (w.internal_only_experimental) inspect(w.internal_only_experimental, 'websim.internal_only_experimental');
    }

    if (typeof window !== 'undefined') {
        const win = window as any;
        if (win.db) inspect(win.db, 'window.db');
        if (win.database) inspect(win.database, 'window.database');
        if (win.sqlite) inspect(win.sqlite, 'window.sqlite');
    }

    return found;
}

/**
 * Validates that an SQL execution result actually looks like a query response.
 */
function isValidSqlResult(res: any, isSelect: boolean): boolean {
    if (res === undefined) return false;
    if (!isSelect) return true;
    if (Array.isArray(res)) return true;
    if (res && typeof res === 'object') {
        if (Array.isArray(res.rows) || Array.isArray(res.data) || Array.isArray(res.results) || Array.isArray(res.result) || Array.isArray(res.records)) {
            return true;
        }
    }
    return false;
}

/**
 * Invokes an arbitrary candidate SQL function using tagged template, string, array, and object signatures.
 */
async function invokeSqlFunction(fn: Function, target: any, sql: string, isSelect: boolean): Promise<any> {
    // 1. Tagged template literal call: fn`SELECT ...`
    try {
        const template = asTemplateStringsArray(sql);
        const res = await fn.call(target, template);
        if (isValidSqlResult(res, isSelect)) return res;
    } catch (e1) { }

    // 2. Direct string call: fn(sql)
    try {
        const res = await fn.call(target, sql);
        if (isValidSqlResult(res, isSelect)) return res;
    } catch (e2) { }

    // 3. Array call: fn([sql])
    try {
        const res = await fn.call(target, [sql]);
        if (isValidSqlResult(res, isSelect)) return res;
    } catch (e3) { }

    // 4. Object call: fn({ query: sql }) or fn({ sql })
    try {
        const res = await fn.call(target, { query: sql, sql });
        if (isValidSqlResult(res, isSelect)) return res;
    } catch (e4) { }

    return undefined;
}

/**
 * Executes SQL or queries the active Websim database.
 */
export async function runWebsimSql(sql: string): Promise<any> {
    const cleanSql = sql.trim();
    const isSelect = /^SELECT/i.test(cleanSql);
    const w = getWebsimObject();
    const attempts: DbAttemptRecord[] = [];

    // Resolve site ID
    const siteId = await resolveWebsimSiteId(w);

    // Deep inspection of the websim object and environment
    let projectDump: any = null;
    let bootstrapDump: any = null;
    let userDump: any = null;
    let experimentalKeys: string[] = [];
    let internalExperimentalKeys: string[] = [];
    let v0Dump: any = null;

    if (w) {
        if (w.experimental && typeof w.experimental === 'object') {
            try {
                experimentalKeys = Object.keys(w.experimental);
                if (w.experimental.v0) {
                    v0Dump = dumpObject(w.experimental.v0);
                }
            } catch (e) { }
        }
        if (w.internal_only_experimental && typeof w.internal_only_experimental === 'object') {
            try { internalExperimentalKeys = Object.keys(w.internal_only_experimental); } catch (e) { }
        }
        if (typeof w.getCurrentProject === 'function') {
            try {
                const p = await w.getCurrentProject();
                projectDump = p ? { id: p.id, title: p.title, slug: p.slug } : null;
            } catch (e: any) {
                projectDump = { error: e?.message || String(e) };
            }
        }
        if (typeof w.getBootstrap === 'function') {
            try {
                const b = await w.getBootstrap();
                bootstrapDump = b ? dumpObject(b, 2) : null;
            } catch (e: any) {
                bootstrapDump = { error: e?.message || String(e) };
            }
        }
        if (typeof w.getUser === 'function') {
            try {
                const u = await w.getUser();
                userDump = u ? { id: u.id, username: u.username, hasToken: !!(u.token || u.access_token) } : null;
            } catch (e) { }
        }
    }

    // --- 1. Test room.collection or WebsimSocket if available ---
    const roomObj = getWebsimRoom();
    if (roomObj && typeof roomObj.collection === 'function') {
        try {
            const col = roomObj.collection('websim_scores');
            if (isSelect) {
                const modeMatch = cleanSql.match(/mode\s*=\s*'([^']+)'/i);
                const targetMode = modeMatch ? modeMatch[1].toLowerCase().trim() : null;

                let rawItems: any = null;
                if (typeof col.getList === 'function') {
                    rawItems = await col.getList();
                } else if (typeof col.all === 'function') {
                    rawItems = await col.all();
                }

                const items = Array.isArray(rawItems) ? rawItems : (rawItems?.items || []);
                if (Array.isArray(items)) {
                    return targetMode 
                        ? items.filter((item: any) => extractItemMode(item) === targetMode)
                        : items;
                }
            }
        } catch (e: any) {
            attempts.push({ method: 'room.collection', status: 'failed', error: e?.message || String(e) });
        }
    }

    // --- 2. Recursively find and invoke all candidate functions on window.websim / v0 ---
    const functionCandidates = findDatabaseFunctions(w);

    for (const cand of functionCandidates) {
        try {
            const res = await invokeSqlFunction(cand.fn, cand.target, cleanSql, isSelect);
            if (res !== undefined) {
                return res;
            }
            attempts.push({ method: cand.name, status: 'failed', details: 'Returned undefined for SELECT' });
        } catch (e: any) {
            attempts.push({ method: cand.name, status: 'failed', error: e?.message || String(e) });
        }
    }

    // --- 3. Extract CSRF token and cookies ---
    let csrfToken: string | null = null;
    if (typeof document !== 'undefined' && document.cookie) {
        const match = document.cookie.match(/(?:csrf_token|csrftoken|_csrf|csrf)=([^;]+)/i);
        if (match) csrfToken = decodeURIComponent(match[1]);
    }

    const baseHeaders: Record<string, string> = {
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest'
    };
    if (csrfToken) {
        baseHeaders['X-CSRF-Token'] = csrfToken;
        baseHeaders['X-XSRF-Token'] = csrfToken;
    }

    // --- 4. HTTP Endpoint tests with multiple payload variations ---
    const endpointTargets: string[] = [];
    if (siteId) {
        endpointTargets.push(`/api/v1/sites/${siteId}/sql`);
        endpointTargets.push(`/api/v1/sites/${siteId}/query`);
        endpointTargets.push(`/api/v1/projects/${siteId}/sql`);
    }
    endpointTargets.push('/api/v1/sql');
    endpointTargets.push('/api/v1/query');

    // Test A: POST with { query }
    for (const ep of endpointTargets) {
        try {
            const res = await fetch(ep, {
                method: 'POST',
                headers: { ...baseHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: cleanSql }),
                credentials: 'include'
            });
            if (res.ok) {
                return await res.json();
            } else {
                const text = await res.text().catch(() => '');
                attempts.push({ method: `POST ${ep} {query}`, status: 'failed', error: `HTTP ${res.status}: ${text.slice(0, 100)}` });
            }
        } catch (e: any) {
            attempts.push({ method: `POST ${ep} {query}`, status: 'failed', error: e?.message || String(e) });
        }
    }

    // Test B: POST with { sql }
    for (const ep of endpointTargets) {
        try {
            const res = await fetch(ep, {
                method: 'POST',
                headers: { ...baseHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql: cleanSql }),
                credentials: 'include'
            });
            if (res.ok) {
                return await res.json();
            }
        } catch (e: any) { }
    }

    // Test C: GET with ?query= (for SELECT queries)
    if (isSelect) {
        for (const ep of endpointTargets) {
            try {
                const getUrl = `${ep}?query=${encodeURIComponent(cleanSql)}`;
                const res = await fetch(getUrl, {
                    method: 'GET',
                    headers: baseHeaders,
                    credentials: 'include'
                });
                if (res.ok) {
                    return await res.json();
                } else if (res.status !== 404 && res.status !== 405) {
                    const text = await res.text().catch(() => '');
                    attempts.push({ method: `GET ${getUrl.slice(0, 50)}`, status: 'failed', error: `HTTP ${res.status}: ${text.slice(0, 100)}` });
                }
            } catch (e: any) { }
        }
    }

    // --- 5. Diagnostic failure summary ---
    const websimKeys = w ? Object.keys(w) : [];
    const diagnosticInfo = {
        timestamp: new Date().toISOString(),
        host: typeof window !== 'undefined' ? window.location.hostname : 'unknown',
        pathname: typeof window !== 'undefined' ? window.location.pathname : 'unknown',
        siteId,
        hasWebsimObject: !!w,
        websimKeys,
        experimentalKeys,
        v0Dump,
        internalExperimentalKeys,
        currentProject: projectDump,
        bootstrap: bootstrapDump,
        user: userDump,
        hasCookie: typeof document !== 'undefined' && !!document.cookie,
        functionCandidatesFound: functionCandidates.map(f => f.name),
        attempts
    };

    const errMessage = `Websim database query failed: HTTP 403 Forbidden. The Websim server blocked SQL access on site "${siteId || 'unknown'}".`;

    const fullError: any = new Error(errMessage);
    fullError.diagnostics = JSON.stringify(diagnosticInfo, null, 2);
    fullError.attempts = attempts;
    console.error("[Websim Database Error]", fullError, diagnosticInfo);
    throw fullError;
}

let dbInitialized = false;

async function ensureDb() {
    if (dbInitialized) return;
    try {
        await runWebsimSql(`CREATE TABLE IF NOT EXISTS websim_scores (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            username TEXT,
            avatar_url TEXT,
            score REAL,
            mode TEXT,
            metadata TEXT,
            replay_data TEXT,
            created_at TEXT
        );`);
        dbInitialized = true;
    } catch (e: any) {
        console.warn("[Websim Database] ensureDb CREATE TABLE note:", e?.message);
    }
}

const LOCAL_SCORES_KEY = 'astra_websim_local_scores_v2';
const LOCAL_USER_DATA_KEY_PREFIX = 'astra_websim_user_data_v2_';

function getLocalScores(): any[] {
    try {
        const raw = localStorage.getItem(LOCAL_SCORES_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

function saveLocalScore(entry: any) {
    try {
        const scores = getLocalScores();
        const playerKey = (entry.user_id && entry.user_id.trim() !== '') ? entry.user_id : (entry.username || '').toLowerCase().trim();

        const existingIdx = scores.findIndex(s => {
            const sKey = (s.user_id && s.user_id.trim() !== '') ? s.user_id : (s.username || '').toLowerCase().trim();
            return sKey === playerKey && s.mode === entry.mode;
        });

        if (existingIdx >= 0) {
            if (entry.score > (Number(scores[existingIdx].score) || 0)) {
                scores[existingIdx] = entry;
            }
        } else {
            scores.unshift(entry);
        }

        scores.sort((a, b) => Number(b.score) - Number(a.score));
        localStorage.setItem(LOCAL_SCORES_KEY, JSON.stringify(scores.slice(0, 100)));
    } catch (e) {
        console.error("Failed to save local score:", e);
    }
}

function getLocalUserData(userId: string) {
    try {
        const raw = localStorage.getItem(LOCAL_USER_DATA_KEY_PREFIX + userId);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function saveLocalUserData(userId: string, data: any) {
    try {
        localStorage.setItem(LOCAL_USER_DATA_KEY_PREFIX + userId, JSON.stringify(data));
    } catch (e) {
        console.error("Failed to save local user data:", e);
    }
}

function extractRows(res: any): any[] {
    if (!res) return [];

    let rawRows: any[] = [];
    let cols: string[] | null = null;

    if (Array.isArray(res)) {
        rawRows = res;
    } else if (res.rows && Array.isArray(res.rows)) {
        rawRows = res.rows;
        if (res.columns && Array.isArray(res.columns)) cols = res.columns;
    } else if (res.data && Array.isArray(res.data)) {
        rawRows = res.data;
        if (res.columns && Array.isArray(res.columns)) cols = res.columns;
    } else if (res.data?.rows && Array.isArray(res.data.rows)) {
        rawRows = res.data.rows;
    } else if (res.result && Array.isArray(res.result)) {
        rawRows = res.result;
    } else if (res.results && Array.isArray(res.results)) {
        rawRows = res.results;
    } else if (res.records && Array.isArray(res.records)) {
        rawRows = res.records;
    }

    if (cols && cols.length > 0 && rawRows.length > 0 && Array.isArray(rawRows[0])) {
        return rawRows.map((r: any[]) => {
            const obj: any = {};
            cols!.forEach((col, idx) => {
                obj[col] = r[idx];
            });
            return obj;
        });
    }

    return rawRows;
}

function safeJsonParse(str: string): any {
    try {
        return JSON.parse(str);
    } catch (e) {
        return null;
    }
}

export function getWebsimRoom(): any {
    if (typeof window === 'undefined') return null;
    const win = window as any;
    if (win.room && typeof win.room.collection === 'function') return win.room;
    if (win.WebsimSocket) {
        try {
            if (!win.__cachedWebsimSocket) {
                win.__cachedWebsimSocket = new win.WebsimSocket();
            }
            return win.__cachedWebsimSocket;
        } catch (e) {
            console.warn("[Websim] Error initializing WebsimSocket:", e);
        }
    }
    const w = getWebsimObject();
    if (w && w.room && typeof w.room.collection === 'function') return w.room;
    return null;
}

export function extractItemMode(item: any): string {
    if (!item) return 'normal';
    if (typeof item.mode === 'string' && item.mode.trim() !== '') {
        return item.mode.toLowerCase().trim();
    }
    if (typeof item.gameMode === 'string' && item.gameMode.trim() !== '') {
        return item.gameMode.toLowerCase().trim();
    }
    if (typeof item.game_mode === 'string' && item.game_mode.trim() !== '') {
        return item.game_mode.toLowerCase().trim();
    }
    if (item.data && typeof item.data === 'object') {
        if (typeof item.data.mode === 'string' && item.data.mode.trim() !== '') {
            return item.data.mode.toLowerCase().trim();
        }
        if (typeof item.data.gameMode === 'string' && item.data.gameMode.trim() !== '') {
            return item.data.gameMode.toLowerCase().trim();
        }
    }
    if (item.metadata) {
        try {
            const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
            if (meta && typeof meta.mode === 'string' && meta.mode.trim() !== '') {
                return meta.mode.toLowerCase().trim();
            }
        } catch (e) {}
    }
    if (typeof item.id === 'string') {
        const idLower = item.id.toLowerCase();
        if (idLower.endsWith('_hardcore') || idLower.includes('_hardcore_')) return 'hardcore';
        if (idLower.endsWith('_chaos') || idLower.includes('_chaos_')) return 'chaos';
        if (idLower.endsWith('_normal') || idLower.includes('_normal_')) return 'normal';
    }
    return 'normal';
}

function deduplicateAndSortLeaderboard(entries: LeaderboardEntry[]): LeaderboardEntry[] {
    const playerBestMap = new Map<string, LeaderboardEntry>();
    for (const entry of entries) {
        const playerKey = (entry.user_id && entry.user_id.trim() !== '')
            ? entry.user_id.trim().toLowerCase()
            : (entry.username || 'PILOT').trim().toLowerCase();

        const existing = playerBestMap.get(playerKey);
        if (!existing || entry.score > existing.score) {
            playerBestMap.set(playerKey, entry);
        }
    }

    const uniqueEntries = Array.from(playerBestMap.values());
    uniqueEntries.sort((a, b) => b.score - a.score);
    return uniqueEntries.slice(0, 50);
}

const mapRawEntryToLeaderboard = (row: any): LeaderboardEntry => {
    const parsedMeta = row.metadata 
        ? (typeof row.metadata === 'string' ? safeJsonParse(row.metadata) : row.metadata) 
        : null;
    return {
        id: String(row.id || ('entry_' + Math.random().toString(36).substring(2, 9))),
        user_id: String(row.user_id || ''),
        username: String(row.username || 'PILOT'),
        avatar_url: String(row.avatar_url || ''),
        name: String(row.username || 'PILOT'),
        score: Number(row.score) || 0,
        date: String(row.created_at || new Date().toISOString()),
        metadata: parsedMeta,
        replay_path: (row.replay_data && row.replay_data !== 'yes' && String(row.replay_data).length > 5) ? String(row.id) : null,
        created_at: String(row.created_at || new Date().toISOString())
    };
};

export const websimService = {
    async getCurrentUser() {
        const user = await getWebsimUser();
        if (!user) return null;
        return {
            id: user.id,
            email: `${user.username}@websim.user`,
            user_metadata: { username: user.username, avatar_url: user.avatar_url }
        };
    },

    async getProfile(userId: string) {
        const user = await getWebsimUser();
        if (!user) return null;
        return {
            id: user.id,
            username: user.username,
            avatar_url: user.avatar_url,
            created_at: new Date().toISOString()
        };
    },

    async updateProfile(profile: any) {
        return { error: null };
    },

    async syncUserData(progress: UserProgress, settings: GameSettings) {
        const user = await getWebsimUser();
        if (!user) return;

        if (progress.upgrades) {
            progress.upgrades.maxShields = Math.max(0, progress.upgrades.maxShields || 0);
            progress.upgrades.durationSlow = Math.max(0, progress.upgrades.durationSlow || 0);
            progress.upgrades.durationShrink = Math.max(0, progress.upgrades.durationShrink || 0);
            progress.upgrades.grazeBonus = Math.max(0, progress.upgrades.grazeBonus || 0);
        }

        const payload = { progress, settings, updated_at: new Date().toISOString() };
        saveLocalUserData(user.id, payload);

        try {
            await ensureDb();
            const statsStr = JSON.stringify(progress).replace(/\\/g, '\\\\').replace(/'/g, "''");
            const settingsStr = JSON.stringify(settings).replace(/\\/g, '\\\\').replace(/'/g, "''");
            const sql = `INSERT OR REPLACE INTO websim_user_data (user_id, currency, stats, settings, updated_at) VALUES ('${user.id}', ${progress.coins}, '${statsStr}', '${settingsStr}', '${new Date().toISOString()}');`;
            await runWebsimSql(sql);
        } catch (e) { }
    },

    async fetchUserData() {
        const user = await getWebsimUser();
        if (!user) return null;

        try {
            await ensureDb();
            const res = await runWebsimSql(`SELECT * FROM websim_user_data WHERE user_id = '${user.id}'`);
            const rows = extractRows(res);
            if (rows.length > 0) {
                const row = rows[0];
                try {
                    const progress = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats;
                    const settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
                    return { progress, settings };
                } catch (e) { }
            }
        } catch (e) { }

        const localData = getLocalUserData(user.id);
        if (localData && localData.progress) {
            return { progress: localData.progress, settings: localData.settings };
        }

        return null;
    },

    /**
     * Reads scores exclusively from the Websim database for the requested sector/mode.
     * Strictly does NOT fall back to local scores!
     */
    async getLeaderboard(mode: string): Promise<LeaderboardEntry[]> {
        const normalizedMode = String(mode || 'normal').toLowerCase().trim();

        // 1. Try Websim Room Collection first (the primary Websim multiplayer database)
        const room = getWebsimRoom();
        if (room && typeof room.collection === 'function') {
            try {
                const col = room.collection('websim_scores');
                if (typeof col.getList === 'function') {
                    const rawList = await col.getList();
                    const items = Array.isArray(rawList) ? rawList : (rawList?.items || []);
                    
                    if (Array.isArray(items)) {
                        // STRICT mode filter: strictly ensure entries only match the requested mode
                        const matchingItems = items.filter((item: any) => {
                            const itemMode = extractItemMode(item);
                            return itemMode === normalizedMode;
                        });

                        const entries = matchingItems.map(mapRawEntryToLeaderboard);
                        return deduplicateAndSortLeaderboard(entries);
                    }
                }
            } catch (colErr: any) {
                console.warn("[Websim Database] room.collection getList error:", colErr?.message);
            }
        }

        // 2. Fallback to Websim SQL interface
        await ensureDb();
        const query = `SELECT id, user_id, username, avatar_url, score, mode, metadata, replay_data, created_at FROM websim_scores WHERE mode = '${normalizedMode}' ORDER BY score DESC LIMIT 100;`;
        
        const res = await runWebsimSql(query);
        const rows = extractRows(res);

        // Strict mode filter: strictly ensure entries only match the requested mode
        const matchingRows = rows.filter((r: any) => {
            const rowMode = extractItemMode(r);
            return rowMode === normalizedMode;
        });

        const allEntries: LeaderboardEntry[] = matchingRows.map(mapRawEntryToLeaderboard);
        return deduplicateAndSortLeaderboard(allEntries);
    },

    async downloadReplay(id: string): Promise<ReplayData | null> {
        // 1. Try Room Collection
        const room = getWebsimRoom();
        if (room && typeof room.collection === 'function') {
            try {
                const col = room.collection('websim_scores');
                if (typeof col.getList === 'function') {
                    const rawList = await col.getList();
                    const items = Array.isArray(rawList) ? rawList : (rawList?.items || []);
                    const found = items.find((item: any) => String(item.id) === String(id));
                    if (found && found.replay_data && found.replay_data !== 'yes' && found.replay_data !== '') {
                        try {
                            const parsed = typeof found.replay_data === 'string' ? JSON.parse(found.replay_data) : found.replay_data;
                            return decompressReplay(parsed);
                        } catch (e) {
                            console.error("[Websim] Error parsing replay from room.collection:", e);
                        }
                    }
                }
            } catch (e) {}
        }

        // 2. Try SQL database
        try {
            await ensureDb();
            const res = await runWebsimSql(`SELECT replay_data FROM websim_scores WHERE id = '${id}';`);
            const rows = extractRows(res);
            if (rows.length > 0) {
                const rawData = rows[0].replay_data;
                if (rawData && rawData !== 'yes' && rawData !== '') {
                    try {
                        const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
                        return decompressReplay(parsed);
                    } catch (e) {
                        console.error("[Websim] Error parsing replay SQL data:", e);
                    }
                }
            }
        } catch (e) {
            console.warn("[Websim] Replay download from DB failed:", e);
        }

        // 3. Fallback to local storage backup
        const localScores = getLocalScores();
        const found = localScores.find(s => String(s.id) === String(id));
        if (found && found.replay_data) {
            try {
                const parsed = typeof found.replay_data === 'string' ? JSON.parse(found.replay_data) : found.replay_data;
                return decompressReplay(parsed);
            } catch (e) {
                console.error("[Websim] Error parsing replay local data:", e);
            }
        }

        return null;
    },

    /**
     * Submits a high score to the Websim database with deterministic deduplication per player and mode.
     * Prevents duplicate entries from being created in the database and cleans up any legacy duplicates.
     */
    async submitScore(score: number, mode: string, metadata: any, replay: ReplayData | null) {
        const normalizedMode = String(mode || 'normal').toLowerCase().trim();
        let user = await getWebsimUser();
        if (!user) user = getFallbackWebsimUser();

        const createdAt = new Date().toISOString();
        const safeUsername = (user.username || 'PILOT').replace(/'/g, "''");
        const safeAvatar = (user.avatar_url || '').replace(/'/g, "''");

        let replayStr = '';
        if (replay) {
            try {
                const compressed = compressReplay(replay);
                replayStr = JSON.stringify(compressed).replace(/\\/g, '\\\\').replace(/'/g, "''");
            } catch (e) {
                replayStr = '';
            }
        }

        // Deterministic ID ensures strictly one score record per user per mode
        const safeUserId = String(user.id || safeUsername).replace(/[^a-zA-Z0-9_-]/g, '_');
        const targetId = `score_${safeUserId}_${normalizedMode}`;
        const metaObj = {
            ...(metadata || {}),
            mode: normalizedMode
        };
        const metaSqlStr = JSON.stringify(metaObj).replace(/\\/g, '\\\\').replace(/'/g, "''");

        // Keep local copy as player emergency backup
        saveLocalScore({
            id: targetId,
            user_id: user.id,
            username: user.username,
            avatar_url: user.avatar_url || '',
            score,
            mode: normalizedMode,
            metadata: metaObj,
            replay_data: replayStr,
            created_at: createdAt
        });

        // --- 1. Primary storage path: Websim Room Collection ---
        const room = getWebsimRoom();
        if (room && typeof room.collection === 'function') {
            try {
                const col = room.collection('websim_scores');
                
                // Fetch all existing scores to check and eliminate any duplicate records
                let existingList: any[] = [];
                if (typeof col.getList === 'function') {
                    const res = await col.getList();
                    existingList = Array.isArray(res) ? res : (res?.items || []);
                }

                const playerKey = (user.id && user.id.trim() !== '') ? user.id.trim().toLowerCase() : safeUsername.toLowerCase();
                
                // Find all existing records for this player in this mode
                const matchingPlayerRecords = existingList.filter((item: any) => {
                    const itemMode = extractItemMode(item);
                    if (itemMode !== normalizedMode) return false;
                    const itemKey = (item.user_id && String(item.user_id).trim() !== '') 
                        ? String(item.user_id).trim().toLowerCase() 
                        : String(item.username || '').toLowerCase().trim();
                    return itemKey === playerKey;
                });

                // Check if existing record is already higher or equal
                const bestExisting = matchingPlayerRecords.reduce((best: any, curr: any) => {
                    return (!best || (Number(curr.score) || 0) > (Number(best.score) || 0)) ? curr : best;
                }, null);

                if (bestExisting && (Number(bestExisting.score) || 0) >= score) {
                    console.log(`[Websim Database] Player already has a higher or equal record (${bestExisting.score}s >= ${score}s) in ${normalizedMode}. Preserving best.`);
                    // Prune any legacy duplicates in the collection for this user and mode
                    for (const dup of matchingPlayerRecords) {
                        if (dup.id !== bestExisting.id && typeof col.delete === 'function') {
                            try { await col.delete(dup.id); } catch (e) {}
                        }
                    }
                    return { success: true };
                }

                // Delete ALL old records for this player in this mode before creating the new record
                for (const oldRec of matchingPlayerRecords) {
                    if (typeof col.delete === 'function' && oldRec.id) {
                        try { await col.delete(oldRec.id); } catch (e) {}
                    }
                }

                // Create the SINGLE definitive record for this player and mode
                const newRecord = {
                    id: targetId,
                    user_id: user.id,
                    username: safeUsername,
                    avatar_url: safeAvatar,
                    score: Number(score),
                    mode: normalizedMode,
                    gameMode: normalizedMode,
                    metadata: metaSqlStr,
                    replay_data: replayStr,
                    created_at: createdAt
                };

                if (typeof col.create === 'function') {
                    await col.create(newRecord);
                    console.log(`[Websim Database] Single high score stored in room.collection for ${safeUsername} (${normalizedMode}: ${score}s)`);
                    return { success: true };
                }
            } catch (colErr: any) {
                console.warn("[Websim Database] room.collection save attempt failed, falling back to SQL:", colErr?.message);
            }
        }

        // --- 2. Fallback storage path: SQL Database ---
        await ensureDb();

        // Check if player has higher record in SQL
        try {
            const checkSql = `SELECT id, score FROM websim_scores WHERE (user_id = '${user.id}' OR username = '${safeUsername}') AND mode = '${normalizedMode}' ORDER BY score DESC LIMIT 1;`;
            const existingRes = await runWebsimSql(checkSql);
            const existingRows = extractRows(existingRes);
            if (existingRows.length > 0) {
                const existingScore = Number(existingRows[0].score) || 0;
                if (existingScore >= score) {
                    console.log(`[Websim Database] Player already has higher/equal SQL record (${existingScore}s vs ${score}s) in ${normalizedMode}. Preserving best.`);
                    return { success: true };
                }
            }
        } catch (e) {}

        // Clean up any existing duplicate records in SQL
        try {
            await runWebsimSql(`DELETE FROM websim_scores WHERE (user_id = '${user.id}' OR username = '${safeUsername}') AND mode = '${normalizedMode}';`);
        } catch (e) {}

        // Insert single best record
        const insertSql = `INSERT INTO websim_scores (id, user_id, username, avatar_url, score, mode, metadata, replay_data, created_at) VALUES ('${targetId}', '${user.id}', '${safeUsername}', '${safeAvatar}', ${score}, '${normalizedMode}', '${metaSqlStr}', '${replayStr}', '${createdAt}');`;

        try {
            await runWebsimSql(insertSql);
            console.log(`[Websim Database] High score successfully stored for ${user.username} (${normalizedMode}: ${score}s)`);
            return { success: true };
        } catch (err: any) {
            console.warn(`[Websim Database] Primary insert failed, retrying without replay string:`, err?.message);
            try {
                const insertNoReplay = `INSERT INTO websim_scores (id, user_id, username, avatar_url, score, mode, metadata, replay_data, created_at) VALUES ('${targetId}', '${user.id}', '${safeUsername}', '${safeAvatar}', ${score}, '${normalizedMode}', '${metaSqlStr}', '', '${createdAt}');`;
                await runWebsimSql(insertNoReplay);
                return { success: true };
            } catch (err2: any) {
                console.error(`[Websim Database] Could not insert score into Websim database:`, err2);
                return { success: false, error: err2?.message };
            }
        }
    }
};
