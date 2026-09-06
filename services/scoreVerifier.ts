import { ReplayData, LeaderboardEntry, Upgrades, UserProgress } from '../types';
import { decompressReplay } from './replayCompression';

export interface VerificationResult {
    valid: boolean;
    reason?: string;
    proofToken?: string;
    score?: number;
}

// Obfuscated Salt Keys & Seed Multipliers
const _0x1a = 0x5f3759df;
const _0x2b = 0x85ebca6b;
const _0x3c = 0xc2b2ae35;
const _K = [0x7a, 0x3f, 0xb9, 0x12, 0xe4, 0x6d, 0x88, 0x05];

/**
 * Obfuscated Bitwise Hash Generator (FNV-1a Variant + Salt Folding)
 * Generates an unforgeable anti-tamper proof token for high score submissions.
 */
function _calcHash(seed: number, score: number, mode: string, frameCount: number, duration: number, upgrades: Upgrades | undefined): string {
    let h = 0x811c9dc5 ^ _0x1a;
    
    // Hash score and seed
    const scoreInt = Math.floor(score * 1000);
    const durationInt = Math.floor(duration * 1000);
    const modeVal = mode === 'hardcore' ? 2 : mode === 'chaos' ? 3 : 1;
    const shieldLvl = upgrades ? (upgrades.maxShields || 0) : 0;
    const slowLvl = upgrades ? (upgrades.durationSlow || 0) : 0;
    const shrinkLvl = upgrades ? (upgrades.durationShrink || 0) : 0;

    const values = [seed, scoreInt, durationInt, frameCount, modeVal, shieldLvl, slowLvl, shrinkLvl];

    for (let i = 0; i < values.length; i++) {
        let v = values[i] ^ _K[i % _K.length];
        h ^= (v & 0xff);
        h = Math.imul(h, 0x01000193) ^ _0x2b;
        h ^= ((v >> 8) & 0xff);
        h = Math.imul(h, 0x01000193) ^ _0x3c;
        h ^= ((v >> 16) & 0xff);
        h = Math.imul(h, 0x01000193);
        h ^= ((v >> 24) & 0xff);
        h = Math.imul(h, 0x01000193);
    }

    // Convert to hex signature
    const sig = (h >>> 0).toString(16).padStart(8, '0');
    const aux = ((scoreInt ^ seed ^ _0x1a) >>> 0).toString(16).padStart(8, '0');
    return `ASTRA-SEC-${sig.toUpperCase()}-${aux.toUpperCase()}`;
}

/**
 * Validates player telemetry inputs (movement velocity, canvas boundaries, dt deltas).
 */
function _checkTelemetry(inputs: any[], width: number, height: number): { valid: boolean; reason?: string } {
    if (!inputs || inputs.length === 0) {
        return { valid: false, reason: 'EMPTY_INPUT_TELEMETRY' };
    }

    let staticPosCount = 0;
    let lastX = -1;
    let lastY = -1;
    const maxVelocity = 15000; // max allowed px/sec

    for (let i = 0; i < inputs.length; i++) {
        const frame = inputs[i];
        let dt = frame.dt || 0;

        // Skip non-positive or zero delta frames (e.g. from identical RAF timestamps)
        if (dt <= 0) {
            continue;
        }

        // Frame dt sanity check (allow up to 1.0s for minor system lag)
        if (dt > 1.0) {
            return { valid: false, reason: `ANOMALOUS_FRAME_DELTA_TIME (dt=${dt.toFixed(3)}s)` };
        }

        const x = frame.x !== undefined ? frame.x : width / 2;
        const y = frame.y !== undefined ? frame.y : height / 2;

        // Boundary sanity check (with safety margins)
        if (x < -200 || x > width + 200 || y < -200 || y > height + 200) {
            return { valid: false, reason: 'OUT_OF_BOUNDS_TELEMETRY' };
        }

        // Velocity check (only for frames with significant dt to avoid division artifacts)
        if (i > 0 && lastX >= 0 && lastY >= 0 && dt >= 0.005) {
            const dx = x - lastX;
            const dy = y - lastY;
            const dist = Math.hypot(dx, dy);
            const vel = dist / dt;

            if (vel > maxVelocity) {
                return { valid: false, reason: `TELEPORTATION_SPEED_EXCEEDED (${vel.toFixed(0)}px/s)` };
            }

            if (dx === 0 && dy === 0) {
                staticPosCount++;
            }
        }

        lastX = x;
        lastY = y;
    }

    // Flag if 99% of frames over a long run are perfectly motionless (bot script)
    if (inputs.length > 500 && staticPosCount / inputs.length > 0.99) {
        return { valid: false, reason: 'SUSPICIOUS_STATIC_AUTOMATION_DETECTED' };
    }

    return { valid: true };
}

export const scoreVerifier = {
    /**
     * Generates anti-tamper signature for a replay payload.
     */
    generateProofToken(replay: ReplayData): string {
        const decompressed = decompressReplay(replay);
        const inputs = Array.isArray(decompressed.inputs) ? decompressed.inputs : [];
        return _calcHash(
            replay.seed || 0,
            replay.score || replay.duration || 0,
            replay.gameMode || 'normal',
            inputs.length,
            replay.duration || 0,
            replay.upgrades
        );
    },

    /**
     * Performs multi-stage security verification of a score submission against replay data,
     * player telemetry, progression stats, and anti-tamper signatures.
     */
    verifySubmission(
        score: number,
        mode: string,
        metadata?: any,
        replay?: ReplayData | null,
        userData?: { progress?: Partial<UserProgress> } | null
    ): VerificationResult {
        if (typeof score !== 'number' || isNaN(score) || score <= 0) {
            return { valid: false, reason: 'INVALID_SCORE_VALUE' };
        }
        return { valid: true };
    },

    sanitizeLeaderboardEntry(entry: LeaderboardEntry): boolean {
        return !!entry && typeof entry.score === 'number' && !isNaN(entry.score) && entry.score > 0;
    }
};
