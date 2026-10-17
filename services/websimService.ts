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
        // Ignore cross-origin frame restriction
    }
    try {
        if (win.top && win.top !== win && win.top.websim) {
            return win.top.websim;
        }
    } catch (e) {
        // Ignore cross-origin frame restriction
    }
    return null;
}

export const isWebsim = (): boolean => {
    if (typeof window === 'undefined') return false;
    if (getWebsimObject()) return true;
    const host = window.location.hostname || '';
    const href = window.location.href || '';
    return host.includes('websim.ai') || host.includes('websim.app') || host.includes('websim.page') || host.includes('websim.site') || href.includes('websim');
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
    if (w && typeof w.getUser === 'function') {
        try {
            const user = await w.getUser();
            if (user && user.id) return user;
        } catch (e) {
            console.error("[Websim] Error getting websim user:", e);
        }
    }
    return getFallbackWebsimUser();
}

function getWebsimSiteId(): string | null {
    if (typeof window === 'undefined') return null;
    const w = getWebsimObject();
    if (w) {
        if (w.siteId) return String(w.siteId);
        if (w.site_id) return String(w.site_id);
        if (typeof w.getSiteId === 'function') {
            try { const id = w.getSiteId(); if (id) return String(id); } catch (e) { }
        }
        if (typeof w.getCreatedSite === 'function') {
            try { const s = w.getCreatedSite(); if (s && s.id) return String(s.id); } catch (e) { }
        }
    }
    const match = window.location.pathname.match(/\/sites\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
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

/**
 * Executes SQL on Websim's database system.
 * Tests all available interfaces:
 *  1. window.websim.sql (tagged template literal)
 *  2. window.websim.sql (direct string call)
 *  3. window.websim.sql (array call)
 *  4. window.websim.query
 *  5. window.websim.database.sql / query
 *  6. window.websim.db.sql / query
 *  7. HTTP POST to /api/v1/sites/{siteId}/sql
 *  8. HTTP POST to /api/v1/sql
 *  9. HTTP POST to /api/sql
 *
 * If all attempts fail, throws a comprehensive error with diagnostics.
 */
export async function runWebsimSql(sql: string): Promise<any> {
    const cleanSql = sql.trim();
    const isSelect = /^SELECT/i.test(cleanSql);
    const isCreate = /^CREATE/i.test(cleanSql);
    const w = getWebsimObject();
    const attempts: DbAttemptRecord[] = [];

    // --- 1. Direct window.websim method attempts ---
    if (w) {
        // Tagged template invocation: websim.sql`...`
        if (typeof w.sql === 'function') {
            try {
                const template = asTemplateStringsArray(cleanSql);
                const res = await w.sql(template);
                // For non-SELECT (like CREATE TABLE or INSERT), void/null/undefined is successful execution
                if (res !== undefined || !isSelect) {
                    return res !== undefined ? res : { rows: [], success: true };
                }
                attempts.push({ method: 'window.websim.sql (tagged template)', status: 'failed', details: 'Returned undefined for SELECT' });
            } catch (e: any) {
                attempts.push({ method: 'window.websim.sql (tagged template)', status: 'failed', error: e?.message || String(e) });
            }

            // Direct string invocation: websim.sql(sql)
            try {
                const res = await w.sql(cleanSql);
                if (res !== undefined || !isSelect) {
                    return res !== undefined ? res : { rows: [], success: true };
                }
                attempts.push({ method: 'window.websim.sql (string parameter)', status: 'failed', details: 'Returned undefined for SELECT' });
            } catch (e: any) {
                attempts.push({ method: 'window.websim.sql (string parameter)', status: 'failed', error: e?.message || String(e) });
            }

            // Array invocation: websim.sql([sql])
            try {
                const res = await w.sql([cleanSql]);
                if (res !== undefined || !isSelect) {
                    return res !== undefined ? res : { rows: [], success: true };
                }
                attempts.push({ method: 'window.websim.sql (array parameter)', status: 'failed', details: 'Returned undefined for SELECT' });
            } catch (e: any) {
                attempts.push({ method: 'window.websim.sql (array parameter)', status: 'failed', error: e?.message || String(e) });
            }
        } else {
            attempts.push({ method: 'window.websim.sql', status: 'skipped', details: 'Not a function on window.websim' });
        }

        // websim.query
        if (typeof w.query === 'function') {
            try {
                const res = await w.query(cleanSql);
                if (res !== undefined || !isSelect) {
                    return res !== undefined ? res : { rows: [], success: true };
                }
                attempts.push({ method: 'window.websim.query (string parameter)', status: 'failed', details: 'Returned undefined for SELECT' });
            } catch (e: any) {
                attempts.push({ method: 'window.websim.query (string parameter)', status: 'failed', error: e?.message || String(e) });
            }

            try {
                const template = asTemplateStringsArray(cleanSql);
                const res = await w.query(template);
                if (res !== undefined || !isSelect) {
                    return res !== undefined ? res : { rows: [], success: true };
                }
                attempts.push({ method: 'window.websim.query (tagged template)', status: 'failed', details: 'Returned undefined for SELECT' });
            } catch (e: any) {
                attempts.push({ method: 'window.websim.query (tagged template)', status: 'failed', error: e?.message || String(e) });
            }
        }

        // websim.database object
        if (w.database) {
            const dbObj = w.database;
            if (typeof dbObj.sql === 'function') {
                try {
                    const res = await dbObj.sql(asTemplateStringsArray(cleanSql));
                    if (res !== undefined || !isSelect) return res !== undefined ? res : { rows: [], success: true };
                } catch (e: any) {
                    attempts.push({ method: 'window.websim.database.sql', status: 'failed', error: e?.message || String(e) });
                }
            }
            if (typeof dbObj.query === 'function') {
                try {
                    const res = await dbObj.query(cleanSql);
                    if (res !== undefined || !isSelect) return res !== undefined ? res : { rows: [], success: true };
                } catch (e: any) {
                    attempts.push({ method: 'window.websim.database.query', status: 'failed', error: e?.message || String(e) });
                }
            }
        }

        // websim.db object
        if (w.db) {
            const dbObj = w.db;
            if (typeof dbObj.sql === 'function') {
                try {
                    const res = await dbObj.sql(asTemplateStringsArray(cleanSql));
                    if (res !== undefined || !isSelect) return res !== undefined ? res : { rows: [], success: true };
                } catch (e: any) {
                    attempts.push({ method: 'window.websim.db.sql', status: 'failed', error: e?.message || String(e) });
                }
            }
            if (typeof dbObj.query === 'function') {
                try {
                    const res = await dbObj.query(cleanSql);
                    if (res !== undefined || !isSelect) return res !== undefined ? res : { rows: [], success: true };
                } catch (e: any) {
                    attempts.push({ method: 'window.websim.db.query', status: 'failed', error: e?.message || String(e) });
                }
            }
        }
    } else {
        attempts.push({ method: 'window.websim object', status: 'skipped', details: 'window.websim not found on window or parent' });
    }

    // --- 2. HTTP Endpoint attempts ---
    const headers = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ sql: cleanSql, query: cleanSql });
    const siteId = getWebsimSiteId();

    const endpoints: string[] = [];
    if (siteId) {
        endpoints.push(`/api/v1/sites/${siteId}/sql`);
    }
    endpoints.push('/api/v1/sql');
    endpoints.push('/api/sql');

    for (const ep of endpoints) {
        try {
            const res = await fetch(ep, { method: 'POST', headers, body });
            if (res.ok) {
                const json = await res.json();
                return json;
            } else {
                const text = await res.text().catch(() => '');
                attempts.push({ method: `HTTP POST ${ep}`, status: 'failed', error: `HTTP ${res.status}: ${text.slice(0, 100)}` });
            }
        } catch (e: any) {
            attempts.push({ method: `HTTP POST ${ep}`, status: 'failed', error: e?.message || String(e) });
        }
    }

    // --- 3. If all attempts failed, throw a detailed diagnostic error ---
    const websimKeys = w ? Object.keys(w) : [];
    const diagnosticInfo = {
        timestamp: new Date().toISOString(),
        host: typeof window !== 'undefined' ? window.location.hostname : 'unknown',
        pathname: typeof window !== 'undefined' ? window.location.pathname : 'unknown',
        siteId,
        hasWebsimObject: !!w,
        websimKeys,
        sqlQuery: cleanSql.slice(0, 120),
        attempts
    };

    const errMessage = w && websimKeys.length > 0
        ? `Websim database query failed. Database API methods on window.websim were tried but could not execute. (Available window.websim keys: [${websimKeys.join(', ')}])`
        : `Websim database not reachable. No active Websim database API or endpoint could be found on host ${typeof window !== 'undefined' ? window.location.hostname : ''}.`;

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
        // Log CREATE TABLE issue, but do not block SELECT in case table exists or DDL is disabled
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
        } catch (e) {
            // User data sync fallback to local is acceptable
        }
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
                } catch (e) {
                    // Ignore parse error
                }
            }
        } catch (e) {
            // Fall back to local
        }

        const localData = getLocalUserData(user.id);
        if (localData && localData.progress) {
            return { progress: localData.progress, settings: localData.settings };
        }

        return null;
    },

    /**
     * Reads scores exclusively from the Websim database.
     * NOTE: Strictly does NOT fall back to local scores!
     * If the database cannot be queried, throws an error so Hall of Fame can present the diagnosis.
     */
    async getLeaderboard(mode: string): Promise<LeaderboardEntry[]> {
        await ensureDb();

        const query = `SELECT id, user_id, username, avatar_url, score, mode, metadata, replay_data, created_at FROM websim_scores WHERE mode = '${mode}' ORDER BY score DESC LIMIT 100;`;
        
        // This will throw if the Websim database is unavailable/failing
        const res = await runWebsimSql(query);
        const rows = extractRows(res);

        const mapEntry = (row: any): LeaderboardEntry => ({
            id: String(row.id || ('entry_' + Math.random().toString(36).substring(2, 9))),
            user_id: String(row.user_id || ''),
            username: String(row.username || 'PILOT'),
            avatar_url: String(row.avatar_url || ''),
            name: String(row.username || 'PILOT'),
            score: Number(row.score) || 0,
            date: String(row.created_at || new Date().toISOString()),
            metadata: row.metadata ? (typeof row.metadata === 'string' ? safeJsonParse(row.metadata) : row.metadata) : null,
            replay_path: (row.replay_data && row.replay_data !== 'yes' && String(row.replay_data).length > 5) ? String(row.id) : null,
            created_at: String(row.created_at || new Date().toISOString())
        });

        const allEntries: LeaderboardEntry[] = rows.map(mapEntry);

        // Deduplicate: Display strictly only ONE best score per player
        const playerBestMap = new Map<string, LeaderboardEntry>();
        for (const entry of allEntries) {
            const playerKey = (entry.user_id && entry.user_id.trim() !== '')
                ? entry.user_id
                : (entry.username || 'PILOT').trim().toLowerCase();

            const existing = playerBestMap.get(playerKey);
            if (!existing || entry.score > existing.score) {
                playerBestMap.set(playerKey, entry);
            }
        }

        const uniqueEntries = Array.from(playerBestMap.values());
        uniqueEntries.sort((a, b) => b.score - a.score);

        // No anti-cheat or score checks while debugging
        return uniqueEntries.slice(0, 50);
    },

    async downloadReplay(id: string): Promise<ReplayData | null> {
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

        const localScores = getLocalScores();
        const found = localScores.find(s => s.id === id);
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
     * Submits a high score to the Websim database without anti-cheat restrictions.
     */
    async submitScore(score: number, mode: string, metadata: any, replay: ReplayData | null) {
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

        const targetId = 'score_' + Math.random().toString(36).substring(2, 11);
        const metaSqlStr = JSON.stringify(metadata || {}).replace(/\\/g, '\\\\').replace(/'/g, "''");

        // Keep local copy as player emergency backup
        saveLocalScore({
            id: targetId,
            user_id: user.id,
            username: user.username,
            avatar_url: user.avatar_url || '',
            score,
            mode,
            metadata: metadata || {},
            replay_data: replayStr,
            created_at: createdAt
        });

        await ensureDb();

        const insertSql = `INSERT INTO websim_scores (id, user_id, username, avatar_url, score, mode, metadata, replay_data, created_at) VALUES ('${targetId}', '${user.id}', '${safeUsername}', '${safeAvatar}', ${score}, '${mode}', '${metaSqlStr}', '${replayStr}', '${createdAt}');`;

        try {
            await runWebsimSql(insertSql);
            console.log(`[Websim Database] High score successfully stored for ${user.username} (${mode}: ${score}s)`);
            return { success: true };
        } catch (err: any) {
            console.warn(`[Websim Database] Primary insert failed, retrying without replay string:`, err?.message);
            try {
                const insertNoReplay = `INSERT INTO websim_scores (id, user_id, username, avatar_url, score, mode, metadata, replay_data, created_at) VALUES ('${targetId}', '${user.id}', '${safeUsername}', '${safeAvatar}', ${score}, '${mode}', '${metaSqlStr}', '', '${createdAt}');`;
                await runWebsimSql(insertNoReplay);
                console.log(`[Websim Database] High score stored without replay for ${user.username}`);
                return { success: true };
            } catch (err2: any) {
                console.error(`[Websim Database] Could not insert score into Websim database:`, err2);
                return { success: false, error: err2?.message };
            }
        }
    }
};
