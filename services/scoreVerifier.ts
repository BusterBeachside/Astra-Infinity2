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
        const dt = frame.dt || 0;

        // Frame dt sanity check
        if (dt <= 0 || dt > 0.6) {
            return { valid: false, reason: `ANOMALOUS_FRAME_DELTA_TIME (dt=${dt.toFixed(3)}s)` };
        }

        const x = frame.x !== undefined ? frame.x : width / 2;
        const y = frame.y !== undefined ? frame.y : height / 2;

        // Boundary sanity check (with safety margins)
        if (x < -200 || x > width + 200 || y < -200 || y > height + 200) {
            return { valid: false, reason: 'OUT_OF_BOUNDS_TELEMETRY' };
        }

        // Velocity check
        if (i > 0 && lastX >= 0 && lastY >= 0 && dt > 0) {
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
        metadata: any,
        replay: ReplayData | null,
        userData?: { progress?: Partial<UserProgress> } | null
    ): VerificationResult {
        // 1. Basic score bounds check
        if (typeof score !== 'number' || isNaN(score) || score <= 0) {
            return { valid: false, reason: 'INVALID_SCORE_VALUE' };
        }

        // Absolute hard ceiling check (e.g. 1800s / 30 minutes survival max)
        if (score > 1800) {
            return { valid: false, reason: 'EXCEEDED_ABSOLUTE_SCORE_BOUND' };
        }

        // 2. High score submissions MUST attach replay telemetry
        if (score > 10 && !replay) {
            return { valid: false, reason: 'REPLAY_TELEMETRY_REQUIRED' };
        }

        if (replay) {
            // Decompress replay if needed
            const decomp = decompressReplay(replay);
            const inputs = Array.isArray(decomp.inputs) ? decomp.inputs : [];

            // 3. Telemetry Frame Count Sanity
            // A run lasting N seconds must have at least ~10 frames per second minimum
            const expectedMinFrames = Math.max(10, Math.floor((score - 10) * 10));
            if (score > 15 && inputs.length < expectedMinFrames) {
                return {
                    valid: false,
                    reason: `TELEMETRY_FRAME_DEFICIT (got ${inputs.length} frames, expected >= ${expectedMinFrames})`
                };
            }

            // 4. Replay Duration vs Score Matching
            const dtSum = inputs.reduce((acc: number, f: any) => {
                const dtVal = typeof f === 'object' && f !== null ? (f.dt || 0) : typeof f === 'number' ? f : 0;
                return acc + dtVal;
            }, 0);
            const startOffset = replay.loadout?.rocketBoost ? 60 : 0;
            const dtMult = (replay.chaosModules?.brrrrrr) ? 2 : 1;
            const expectedDuration = startOffset + dtSum * dtMult;

            // Tolerance of 3.5 seconds to account for warp effect or game-over freeze delay
            if (Math.abs(expectedDuration - score) > 3.5) {
                return {
                    valid: false,
                    reason: `SCORE_DURATION_MISMATCH (Score: ${score.toFixed(1)}s, Replay: ${expectedDuration.toFixed(1)}s)`
                };
            }

            // 5. Input Telemetry Sanity Checks
            const width = replay.width || 800;
            const height = replay.height || 600;
            const telemCheck = _checkTelemetry(inputs, width, height);
            if (!telemCheck.valid) {
                return { valid: false, reason: telemCheck.reason };
            }

            // 6. Anti-Tamper Signature Proof Verification
            const expectedToken = _calcHash(
                replay.seed || 0,
                score,
                mode,
                inputs.length,
                replay.duration || score,
                replay.upgrades || metadata?.upgrades
            );

            const providedToken = metadata?.proofToken || (replay as any).proofToken;
            if (providedToken && providedToken !== expectedToken) {
                return { valid: false, reason: 'TAMPERED_PROOF_SIGNATURE' };
            }
        }

        // 7. Progression & Account Upgrade Sanity Checks
        const upgrades = metadata?.upgrades || replay?.upgrades;
        if (upgrades) {
            if ((upgrades.maxShields || 0) > 99 || (upgrades.durationSlow || 0) > 99 || (upgrades.durationShrink || 0) > 99 || (upgrades.grazeBonus || 0) > 99) {
                return { valid: false, reason: 'ILLEGAL_UPGRADE_LEVELS' };
            }
        }

        // Check user progression data if available
        if (userData && userData.progress) {
            const p = userData.progress;
            const totalRuns = p.stats?.totalRuns || 0;
            const userUpgrades = p.upgrades;

            // Starter account cap (0 shield, 0 slow, 0 shrink, < 3 runs)
            const isFreshAccount = totalRuns < 3 && (!userUpgrades || (userUpgrades.maxShields === 0 && userUpgrades.durationSlow === 0 && userUpgrades.durationShrink === 0));
            const starterCap = mode === 'hardcore' ? 120 : 200;

            if (isFreshAccount && score > starterCap) {
                return { valid: false, reason: `UNUPGRADED_STARTER_ACCOUNT_SCORE_EXCEEDED (Max ${starterCap}s for fresh account)` };
            }

            // Spoofed upgrades check: claimed upgrade levels cannot exceed user's recorded account levels
            if (upgrades && userUpgrades) {
                if ((upgrades.maxShields || 0) > (userUpgrades.maxShields || 0) ||
                    (upgrades.durationSlow || 0) > (userUpgrades.durationSlow || 0) ||
                    (upgrades.durationShrink || 0) > (userUpgrades.durationShrink || 0)) {
                    return { valid: false, reason: 'SPOOFED_UPGRADE_METADATA_MISMATCH' };
                }
            }
        }

        // Generate verified proof token
        const proofToken = replay ? _calcHash(
            replay.seed || 0,
            score,
            mode,
            Array.isArray(decompressReplay(replay).inputs) ? (decompressReplay(replay).inputs as any[]).length : 0,
            score,
            upgrades
        ) : undefined;

        return {
            valid: true,
            proofToken
        };
    },

    /**
     * Filters leaderboard entries to ensure no unverified or corrupted entries are shown.
     */
    sanitizeLeaderboardEntry(entry: LeaderboardEntry): boolean {
        if (!entry || typeof entry.score !== 'number' || isNaN(entry.score) || entry.score <= 0) {
            return false;
        }

        // Hard upper bound check for any entry
        if (entry.score > 1800) {
            return false;
        }

        // Check metadata if present
        if (entry.metadata) {
            const u = entry.metadata.upgrades;
            if (u && ((u.maxShields || 0) > 5 || (u.durationSlow || 0) > 5 || (u.durationShrink || 0) > 5)) {
                return false;
            }
        }

        return true;
    }
};
