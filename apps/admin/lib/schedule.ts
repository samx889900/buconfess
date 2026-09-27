import { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schedule & Durable Daily Slot Manager (BU Confessions v3.5)
// ---------------------------------------------------------------------------
// Invariants:
//   1. Supabase settings table is the single source of truth for posting schedule.
//   2. GitHub Actions acts as an external heartbeat.
//   3. Posting window is short and deterministic around each configured time slot.
//   4. daily_posting_runs table enforces atomic single-execution per (date, slot).
//   5. Dry-run mode NEVER consumes or mutates daily posting slots.
//   6. Multiple daily slots (e.g. 20:00 and 22:00) each have independent claims.
// ---------------------------------------------------------------------------

export interface ScheduleWindowCheck {
  isWithinWindow: boolean;
  postingDate: string;       // YYYY-MM-DD in configured timezone
  currentLocalTime: string;  // HH:MM
  targetTime: string;        // HH:MM of the matched slot
  scheduleSlot: string;      // Identifies the slot e.g. "20:00"
  diffMinutes: number;       // Minutes elapsed from target
  reason?: string;
}

/**
 * Parses a comma-separated list of HH:MM times.
 */
export function parsePostingTimes(timesStr: string): string[] {
  return timesStr
    .split(',')
    .map((t) => t.trim())
    .filter((t) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(t));
}

/**
 * Checks whether the current time is within any configured posting window.
 * Returns the FIRST matching slot, or the closest non-matching slot for diagnostics.
 *
 * Window definition per slot:
 *   [targetTime - 5 minutes, targetTime + 25 minutes]
 * A 30-minute heartbeat (e.g. running at :00 and :30) is guaranteed to enter
 * this 30-minute window exactly once for each scheduled slot.
 */
export function evaluatePostingWindow(
  now: Date,
  targetTimeStr: string = '00:00,06:00,12:00,18:00',
  timezone: string = 'Asia/Kolkata',
  windowMinutesBefore: number = 5,
  windowMinutesAfter: number = 25
): ScheduleWindowCheck {
  const slots = parsePostingTimes(targetTimeStr);
  
  if (slots.length === 0) {
    return {
      isWithinWindow: false,
      postingDate: '',
      currentLocalTime: '',
      targetTime: targetTimeStr,
      scheduleSlot: targetTimeStr,
      diffMinutes: 0,
      reason: `Invalid daily_posting_time format: '${targetTimeStr}'. Expected comma-separated HH:MM.`,
    };
  }

  // Get current date and time in the configured timezone
  let parts: Intl.DateTimeFormatPart[] = [];
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    parts = formatter.formatToParts(now);
  } catch (tzErr) {
    return {
      isWithinWindow: false,
      postingDate: '',
      currentLocalTime: '',
      targetTime: slots[0],
      scheduleSlot: slots[0],
      diffMinutes: 0,
      reason: `Invalid timezone '${timezone}': ${tzErr instanceof Error ? tzErr.message : String(tzErr)}`,
    };
  }

  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  // en-US with hour12: false might format midnight as "24", normalize to "00"
  let currentHour = parseInt(partMap.hour, 10);
  if (currentHour === 24) currentHour = 0;
  const currentMinute = parseInt(partMap.minute, 10);

  const postingDate = `${partMap.year}-${partMap.month}-${partMap.day}`;
  const currentLocalTime = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;
  const currentTotalMinutes = currentHour * 60 + currentMinute;

  // Check each slot — return the first one within window
  let closestSlot = slots[0];
  let closestDiff = Infinity;

  for (const slot of slots) {
    const [targetHStr, targetMStr] = slot.split(':');
    const targetH = parseInt(targetHStr, 10);
    const targetM = parseInt(targetMStr, 10);
    const targetTotalMinutes = targetH * 60 + targetM;

    let diffMinutes = currentTotalMinutes - targetTotalMinutes;
    // Handle midnight wraparound
    if (diffMinutes < -720) diffMinutes += 1440;
    if (diffMinutes > 720) diffMinutes -= 1440;

    if (Math.abs(diffMinutes) < Math.abs(closestDiff)) {
      closestDiff = diffMinutes;
      closestSlot = slot;
    }

    const isWithinWindow = diffMinutes >= -windowMinutesBefore && diffMinutes <= windowMinutesAfter;
    if (isWithinWindow) {
      // Normalize target date for midnight rollover (e.g. 23:55 for 00:00 slot attributes to upcoming calendar day)
      const targetDateObj = new Date(now.getTime() - diffMinutes * 60 * 1000);
      const targetParts = formatter.formatToParts(targetDateObj);
      const targetPartMap: Record<string, string> = {};
      for (const p of targetParts) {
        targetPartMap[p.type] = p.value;
      }
      const normalizedPostingDate = `${targetPartMap.year}-${targetPartMap.month}-${targetPartMap.day}`;

      return {
        isWithinWindow: true,
        postingDate: normalizedPostingDate,
        currentLocalTime,
        targetTime: slot,
        scheduleSlot: slot,
        diffMinutes,
      };
    }
  }

  // No slot matched — return diagnostic info for the closest slot
  return {
    isWithinWindow: false,
    postingDate,
    currentLocalTime,
    targetTime: closestSlot,
    scheduleSlot: closestSlot,
    diffMinutes: closestDiff,
    reason: `Current local time (${currentLocalTime} ${timezone}) is outside the posting window for all configured slots [${slots.join(', ')}] (closest: ${closestSlot}, ${closestDiff > 0 ? `+${closestDiff}` : closestDiff}m).`,
  };
}

export interface ClaimSlotResult {
  claimed: boolean;
  slotRunId?: number;
  reason?: string;
}

/**
 * Atomically attempts to claim the posting slot in daily_posting_runs.
 * Strict UNIQUE(posting_date, schedule_slot) ensures that:
 *  - A scheduled run cannot execute twice for the same slot.
 *  - Manual dispatch cannot duplicate the slot.
 *  - Two concurrent heartbeats cannot execute the same slot simultaneously.
 *  - The 20:00 slot and 22:00 slot have independent claims.
 */
export async function claimDailyPostingSlot(
  postingDate: string,
  scheduleSlot: string,
  triggerSource: 'scheduled' | 'manual_dispatch' | 'cli',
  supabase: SupabaseClient
): Promise<ClaimSlotResult> {
  const { data, error } = await supabase
    .from('daily_posting_runs')
    .insert({
      posting_date: postingDate,
      schedule_slot: scheduleSlot,
      status: 'running',
      trigger_source: triggerSource,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    if (
      error.code === '23505' ||
      error.message?.includes('duplicate key') ||
      error.message?.includes('unique constraint')
    ) {
      return {
        claimed: false,
        reason: `Posting slot '${scheduleSlot}' on ${postingDate} was already executed or is running.`,
      };
    }

    console.error(`[SCHEDULE] Error claiming daily posting slot (${postingDate}, ${scheduleSlot}):`, error);
    return {
      claimed: false,
      reason: `Database error claiming posting slot: ${error.message}`,
    };
  }

  return {
    claimed: true,
    slotRunId: data.id,
  };
}

/**
 * Updates the daily_posting_runs record upon completion or failure.
 */
export async function finalizeDailyPostingSlot(
  slotRunId: number,
  publishedCount: number,
  supabase: SupabaseClient,
  error?: string
): Promise<void> {
  try {
    await supabase
      .from('daily_posting_runs')
      .update({
        status: error ? 'failed' : 'completed',
        completed_at: new Date().toISOString(),
        published_count: publishedCount,
        error_message: error || null,
      })
      .eq('id', slotRunId);
  } catch (finalizeErr) {
    console.warn(`[SCHEDULE] Failed to finalize daily posting slot ${slotRunId}:`, finalizeErr);
  }
}
