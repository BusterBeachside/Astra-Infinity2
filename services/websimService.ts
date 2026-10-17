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
    // Extract subdomain: e.g. dnql3rgc00mwqp3r7gw2.c.websim.com -> dnql3rgc00mwqp3r7gw2
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

/**
 * Invokes an arbitrary candidate SQL function using tagged template, string, array, and object signatures.
 */
async function invokeSqlFunction(fn: Function, target: any, sql: string, isSelect: boolean): Promise<any> {
    // 1. Tagged template literal call: fn`SELECT ...`
    try {
        const template = asTemplateStringsArray(sql);
        const res = await fn.call(target, template);
        if (res !== undefined || !isSelect) {
            return res !== undefined ? res : { rows: [], success: true };
        }
    } catch (e1) {
        // Continue to signature 2
    }

    // 2. Direct string call: fn(sql)
    try {
        const res = await fn.call(target, sql);
        if (res !== undefined || !isSelect) {
            return res !== undefined ? res : { rows: [], success: true };
        }
    } catch (e2) {
        // Continue to signature 3
    }

    // 3. Array call: fn([sql])
    try {
        const res = await fn.call(target, [sql]);
        if (res !== undefined || !isSelect) {
            return res !== undefined ? res : { rows: [], success: true };
        }
    } catch (e3) {
        // Continue to signature 4
    }

    // 4. Object call: fn({ sql, query: sql })
    try {
        const res = await fn.call(target, { sql, query: sql });
        if (res !== undefined || !isSelect) {
            return res !== undefined ? res : { rows: [], success: true };
        }
    } catch (e4) {
        throw e4;
    }

    return undefined;
}

/**
 * Executes SQL on Websim's database system.
 * Discovers and tests all available interfaces:
 *  1. window.websim.sql, query
 *  2. window.websim.experimental (sql, database, query, sqlite, etc.)
 *  3. window.websim.internal_only_experimental (sql, database, etc.)
 *  4. window.websim.database.sql / query
 *  5. window.websim.db.sql / query
 *  6. HTTP POST to /api/v1/sites/{siteId}/sql, /api/v1/projects/{siteId}/sql, /api/v1/sql
 *  7. Cross-origin HTTP POST with credentials to https://websim.com and https://websim.ai
 */
export async function runWebsimSql(sql: string): Promise<any> {
    const cleanSql = sql.trim();
    const isSelect = /^SELECT/i.test(cleanSql);
    const w = getWebsimObject();
    const attempts: DbAttemptRecord[] = [];

    // Resolve site ID (including subdomain check & async project fetch)
    const siteId = await resolveWebsimSiteId(w);

    // Deep inspection of the websim object for diagnostics
    let projectDump: any = null;
    let bootstrapDump: any = null;
    let experimentalKeys: string[] = [];
    let internalExperimentalKeys: string[] = [];

    if (w) {
        if (w.experimental && typeof w.experimental === 'object') {
            try { experimentalKeys = Object.keys(w.experimental); } catch (e) { }
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
                bootstrapDump = b ? { siteId: b.siteId, site: b.site?.id, project: b.project?.id } : null;
            } catch (e: any) {
                bootstrapDump = { error: e?.message || String(e) };
            }
        }
    }

    // --- 1. Identify all candidate SQL functions on window.websim ---
    const functionCandidates: { name: string; target: any; fn: any }[] = [];

    if (w) {
        // Direct functions on w
        if (typeof w.sql === 'function') functionCandidates.push({ name: 'websim.sql', target: w, fn: w.sql });
        if (typeof w.query === 'function') functionCandidates.push({ name: 'websim.query', target: w, fn: w.query });

        // w.experimental
        if (w.experimental) {
            const exp = w.experimental;
            if (typeof exp.sql === 'function') functionCandidates.push({ name: 'websim.experimental.sql', target: exp, fn: exp.sql });
            if (typeof exp.query === 'function') functionCandidates.push({ name: 'websim.experimental.query', target: exp, fn: exp.query });
            if (typeof exp.sqlite === 'function') functionCandidates.push({ name: 'websim.experimental.sqlite', target: exp, fn: exp.sqlite });
            if (exp.database) {
                if (typeof exp.database.sql === 'function') functionCandidates.push({ name: 'websim.experimental.database.sql', target: exp.database, fn: exp.database.sql });
                if (typeof exp.database.query === 'function') functionCandidates.push({ name: 'websim.experimental.database.query', target: exp.database, fn: exp.database.query });
            }
            if (exp.db) {
                if (typeof exp.db.sql === 'function') functionCandidates.push({ name: 'websim.experimental.db.sql', target: exp.db, fn: exp.db.sql });
                if (typeof exp.db.query === 'function') functionCandidates.push({ name: 'websim.experimental.db.query', target: exp.db, fn: exp.db.query });
            }
        }

        // w.internal_only_experimental
        if (w.internal_only_experimental) {
            const intExp = w.internal_only_experimental;
            if (typeof intExp.sql === 'function') functionCandidates.push({ name: 'websim.internal_only_experimental.sql', target: intExp, fn: intExp.sql });
            if (typeof intExp.query === 'function') functionCandidates.push({ name: 'websim.internal_only_experimental.query', target: intExp, fn: intExp.query });
            if (intExp.database) {
                if (typeof intExp.database.sql === 'function') functionCandidates.push({ name: 'websim.internal_only_experimental.database.sql', target: intExp.database, fn: intExp.database.sql });
                if (typeof intExp.database.query === 'function') functionCandidates.push({ name: 'websim.internal_only_experimental.database.query', target: intExp.database, fn: intExp.database.query });
            }
        }

        // w.database / w.db
        if (w.database) {
            if (typeof w.database.sql === 'function') functionCandidates.push({ name: 'websim.database.sql', target: w.database, fn: w.database.sql });
            if (typeof w.database.query === 'function') functionCandidates.push({ name: 'websim.database.query', target: w.database, fn: w.database.query });
        }
        if (w.db) {
            if (typeof w.db.sql === 'function') functionCandidates.push({ name: 'websim.db.sql', target: w.db, fn: w.db.sql });
            if (typeof w.db.query === 'function') functionCandidates.push({ name: 'websim.db.query', target: w.db, fn: w.db.query });
        }
    }

    // Try candidate functions
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

    // --- 2. HTTP Endpoint attempts ---
    const headers = { 'Content-Type': 'application/json' };
    const body = JSON.stringify({ sql: cleanSql, query: cleanSql });

    const endpoints: string[] = [];
    if (siteId) {
        endpoints.push(`/api/v1/sites/${siteId}/sql`);
        endpoints.push(`/api/v1/projects/${siteId}/sql`);
        endpoints.push(`https://websim.com/api/v1/sites/${siteId}/sql`);
        endpoints.push(`https://websim.ai/api/v1/sites/${siteId}/sql`);
    }
    endpoints.push('/api/v1/sql');
    endpoints.push('/api/sql');
    endpoints.push('https://websim.com/api/v1/sql');
    endpoints.push('https://websim.ai/api/v1/sql');

    for (const ep of endpoints) {
        try {
            const res = await fetch(ep, {
                method: 'POST',
                headers,
                body,
                credentials: 'include'
            });

            if (res.ok) {
                const json = await res.json();
                return json;
            } else {
                const text = await res.text().catch(() => '');
                attempts.push({
                    method: `POST ${ep}`,
                    status: 'failed',
                    error: `HTTP ${res.status}: ${text.slice(0, 120)}`
                });
            }
        } catch (e: any) {
            attempts.push({
                method: `POST ${ep}`,
                status: 'failed',
                error: e?.message || String(e)
            });
        }
    }

    // --- 3. Build diagnostic failure summary ---
    const websimKeys = w ? Object.keys(w) : [];
    const diagnosticInfo = {
        timestamp: new Date().toISOString(),
        host: typeof window !== 'undefined' ? window.location.hostname : 'unknown',
        pathname: typeof window !== 'undefined' ? window.location.pathname : 'unknown',
        siteId,
        hasWebsimObject: !!w,
        websimKeys,
        experimentalKeys,
        internalExperimentalKeys,
        currentProject: projectDump,
        bootstrap: bootstrapDump,
        sqlQuery: cleanSql.slice(0, 120),
        attempts
    };

    const errMessage = w && websimKeys.length > 0
        ? `Websim database query failed. Explored ${functionCandidates.length} SDK functions and ${endpoints.length} HTTP endpoints on host "${typeof window !== 'undefined' ? window.location.hostname : ''}".`
        : `Websim database not reachable. No active Websim database API or endpoint could be reached.`;

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
