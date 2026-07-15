/**
 * premiumSweep.js — Background sweep that expires Premium grants and
 * custom limit overrides once their expiresAt timestamp has passed.
 *
 * premiumDB's getters already treat an expired record as absent (lazy
 * check), so access control never has a bug window -- but without this
 * sweep the Discord Premium *role* would only ever be removed the next
 * time that user happens to trigger a premiumDB read, and no expiration
 * would ever be logged to the Premium Dashboard. This turns that into an
 * active process running on an interval.
 */

import { IDS } from "../config/ids.js";
import { premDB } from "./db.js";
import { revokePremiumRole } from "./premiumRoleSync.js";
import { appendToPremiumLog } from "./premiumLog.js";
import { updateMonitoringDashboard } from "./monitoringDashboard.js";
import { updatePremStatsDashboard } from "./premStatsDashboard.js";
import { logger } from "../utils/logger.js";
import { logError } from "../utils/errorLogger.js";

const SWEEP_INTERVAL_MS = 60 * 1000; // every 60s

async function sweepOnce(client) {
  try {
    let anyChanged = false;

    // ── Expired Premium users → revoke role, delete record, log ──────────
    // NOTE: the record (with its expiresAt/type) is captured BEFORE deleting
    // it — logging after deletion would have nothing left to describe.
    for (const userId of premDB.getExpiredPremiumUsers()) {
      const record = premDB.getPremiumUser(userId);
      premDB.deletePremiumUser(userId);
      await revokePremiumRole(client, IDS.GUILD_ID, userId);
      await appendToPremiumLog(client, {
        action:      "Premium Expired",
        target:      `<@${userId}>`,
        expiredAt:   record?.expiresAt ?? new Date().toISOString(),
        premiumLabel:"Temporary",
      });
      logger.info(`[Premium] Expired premium for user ${userId}`);
      anyChanged = true;
    }

    // ── Expired Premium roles → just delete record, log ───────────────────
    for (const roleId of premDB.getExpiredPremiumRoles()) {
      const record = premDB.getPremiumRole(roleId);
      premDB.deletePremiumRole(roleId);
      await appendToPremiumLog(client, {
        action:      "Premium Expired",
        target:      `<@&${roleId}>`,
        expiredAt:   record?.expiresAt ?? new Date().toISOString(),
        premiumLabel:"Temporary",
      });
      logger.info(`[Premium] Expired premium for role ${roleId}`);
      anyChanged = true;
    }

    // ── Expired custom limits → revert to default AND log ─────────────────
    // Previously these were only deleted (logger.debug), never sent to the
    // Premium Logs channel at all — that was the "Custom Limit habis kadang
    // tidak masuk ke Premium Logs" bug. Now every expiry is logged, same as
    // Premium expiry above.
    for (const userId of premDB.getExpiredCustomLimitUsers()) {
      const record = premDB.getRawCustomLimitUser(userId);
      premDB.deleteCustomLimitUser(userId);
      await appendToPremiumLog(client, {
        action:    "Custom Limit Expired",
        target:    `<@${userId}>`,
        limit:     record?.limit ?? null,
        expiredAt: record?.expiresAt ?? new Date().toISOString(),
      });
      logger.info(`[Premium] Expired custom limit for user ${userId}`);
      anyChanged = true;
    }
    for (const roleId of premDB.getExpiredCustomLimitRoles()) {
      const record = premDB.getRawCustomLimitRole(roleId);
      premDB.deleteCustomLimitRole(roleId);
      await appendToPremiumLog(client, {
        action:    "Custom Limit Expired",
        target:    `<@&${roleId}>`,
        limit:     record?.limit ?? null,
        expiredAt: record?.expiresAt ?? new Date().toISOString(),
      });
      logger.info(`[Premium] Expired custom limit for role ${roleId}`);
      anyChanged = true;
    }

    // ── Update dashboards if anything changed ────────────────────────────
    if (anyChanged) {
      await updateMonitoringDashboard(client);
      updatePremStatsDashboard(client).catch(() => {});
    }
  } catch (e) {
    logger.error(`[Premium] Sweep failed: ${e.message}`);
    await logError({
      feature: "Premium",
      reason:  `Sweep failed: ${e.message}`,
      stage:   "Premium Expiration Sweep",
      error:   e,
    });
  }
}

/**
 * Start the periodic sweep. Call once from clientReady.
 * @param {import("discord.js").Client} client
 */
export function startPremiumSweep(client) {
  // Run once immediately so anything that expired while the bot was down
  // is cleaned up right away, then on a fixed interval afterwards.
  sweepOnce(client);
  setInterval(() => sweepOnce(client), SWEEP_INTERVAL_MS);
  logger.info(`[Premium] Expiration sweep started (every ${SWEEP_INTERVAL_MS / 1000}s)`);
}
