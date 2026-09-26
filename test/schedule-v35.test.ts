import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePostingWindow,
  claimDailyPostingSlot,
  finalizeDailyPostingSlot,
} from '../apps/admin/lib/schedule';
import { validateSettingValue, SETTINGS_ALLOWLIST } from '../apps/admin/lib/settings';

describe('Schedule & Durable Daily Slot Management (v3.5)', () => {
  it('1. Window evaluation: Identifies time inside [target - 5m, target + 25m] window', () => {
    // 22:00 IST is 16:30 UTC
    const dateAt2200Ist = new Date('2026-09-18T16:30:00.000Z');
    const check = evaluatePostingWindow(dateAt2200Ist, '22:00', 'Asia/Kolkata');

    assert.equal(check.isWithinWindow, true);
    assert.equal(check.targetTime, '22:00');
    assert.equal(check.scheduleSlot, '22:00');
    assert.equal(check.postingDate, '2026-09-18');
    assert.equal(check.currentLocalTime, '22:00');
    assert.equal(check.diffMinutes, 0);
  });

  it('2. Window evaluation: Permits boundary times within window (-5m to +25m)', () => {
    // 21:55 IST (5m before 22:00) -> 16:25 UTC
    const dateAt2155 = new Date('2026-09-18T16:25:00.000Z');
    const checkBefore = evaluatePostingWindow(dateAt2155, '22:00', 'Asia/Kolkata');
    assert.equal(checkBefore.isWithinWindow, true);
    assert.equal(checkBefore.diffMinutes, -5);

    // 22:25 IST (25m after 22:00) -> 16:55 UTC
    const dateAt2225 = new Date('2026-09-18T16:55:00.000Z');
    const checkAfter = evaluatePostingWindow(dateAt2225, '22:00', 'Asia/Kolkata');
    assert.equal(checkAfter.isWithinWindow, true);
    assert.equal(checkAfter.diffMinutes, 25);
  });

  it('3. Window evaluation: Skips times strictly outside window', () => {
    // 21:30 IST (30m before 22:00) -> 16:00 UTC
    const dateAt2130 = new Date('2026-09-18T16:00:00.000Z');
    const checkEarly = evaluatePostingWindow(dateAt2130, '22:00', 'Asia/Kolkata');
    assert.equal(checkEarly.isWithinWindow, false);
    assert.ok(checkEarly.reason?.includes('outside the posting window'));

    // 22:30 IST (30m after 22:00) -> 17:00 UTC
    const dateAt2230 = new Date('2026-09-18T17:00:00.000Z');
    const checkLate = evaluatePostingWindow(dateAt2230, '22:00', 'Asia/Kolkata');
    assert.equal(checkLate.isWithinWindow, false);
    assert.ok(checkLate.reason?.includes('outside the posting window'));
  });

  it('4. Window evaluation: Handles invalid time or timezone gracefully', () => {
    const invalidTime = evaluatePostingWindow(new Date(), '99:99', 'Asia/Kolkata');
    assert.equal(invalidTime.isWithinWindow, false);
    assert.ok(invalidTime.reason?.includes('Invalid daily_posting_time'));

    const invalidTz = evaluatePostingWindow(new Date(), '22:00', 'Invalid/Timezone');
    assert.equal(invalidTz.isWithinWindow, false);
    assert.ok(invalidTz.reason?.includes('Invalid timezone'));
  });

  it('5. Durable slot claiming: Prevents duplicate execution of same slot', async () => {
    const claimedSlots = new Set<string>();

    const mockSupabase = {
      from: (table: string) => {
        assert.equal(table, 'daily_posting_runs');
        return {
          insert: (row: { posting_date: string; schedule_slot: string }) => {
            const key = `${row.posting_date}_${row.schedule_slot}`;
            if (claimedSlots.has(key)) {
              return {
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                  }),
                }),
              };
            }
            claimedSlots.add(key);
            return {
              select: () => ({
                single: async () => ({
                  data: { id: 101 },
                  error: null,
                }),
              }),
            };
          },
        };
      },
    } as any;

    // 1st run: claims successfully
    const firstClaim = await claimDailyPostingSlot('2026-09-18', '22:00', 'scheduled', mockSupabase);
    assert.equal(firstClaim.claimed, true);
    assert.equal(firstClaim.slotRunId, 101);

    // 2nd run: attempt by concurrent heartbeat or manual dispatch -> blocked!
    const secondClaim = await claimDailyPostingSlot('2026-09-18', '22:00', 'manual_dispatch', mockSupabase);
    assert.equal(secondClaim.claimed, false);
    assert.ok(secondClaim.reason?.includes('already executed or is running'));
  });

  it('6. Finalizes daily posting slot status upon run completion', async () => {
    let finalizedStatus = '';
    let finalizedCount = -1;

    const mockSupabase = {
      from: () => ({
        update: (updates: any) => ({
          eq: async (col: string, val: any) => {
            assert.equal(col, 'id');
            assert.equal(val, 101);
            finalizedStatus = updates.status;
            finalizedCount = updates.published_count;
            return { error: null };
          },
        }),
      }),
    } as any;

    await finalizeDailyPostingSlot(101, 3, mockSupabase);
    assert.equal(finalizedStatus, 'completed');
    assert.equal(finalizedCount, 3);
  });

  it('7. Settings validation: Enforces HH:MM format for daily_posting_time', () => {
    const def = SETTINGS_ALLOWLIST.daily_posting_time;

    assert.equal(validateSettingValue(def, '22:00'), '22:00');
    assert.equal(validateSettingValue(def, '09:30'), '09:30');
    assert.equal(validateSettingValue(def, '00:00'), '00:00');

    assert.throws(
      () => validateSettingValue(def, '25:00'),
      (err: Error) => {
        assert.match(err.message, /must be in 24-hour HH:MM format/);
        return true;
      }
    );

    assert.throws(
      () => validateSettingValue(def, '10:65'),
      (err: Error) => {
        assert.match(err.message, /must be in 24-hour HH:MM format/);
        return true;
      }
    );

    assert.throws(
      () => validateSettingValue(def, 'invalid'),
      (err: Error) => {
        assert.match(err.message, /must be in 24-hour HH:MM format/);
        return true;
      }
    );
  });

  it('8. Settings validation: Enforces valid IANA timezone for posting_timezone', () => {
    const def = SETTINGS_ALLOWLIST.posting_timezone;

    assert.equal(validateSettingValue(def, 'Asia/Kolkata'), 'Asia/Kolkata');
    assert.equal(validateSettingValue(def, 'UTC'), 'UTC');
    assert.equal(validateSettingValue(def, 'America/New_York'), 'America/New_York');

    assert.throws(
      () => validateSettingValue(def, 'Mars/Olympus_Mons'),
      (err: Error) => {
        assert.match(err.message, /must be a valid IANA timezone/);
        return true;
      }
    );
  });

  it('9. Multi-slot evaluation: Correctly matches both 20:00 and 22:00 IST slots independently', () => {
    // 20:05 IST (14:35 UTC)
    const at2005 = new Date('2026-09-18T14:35:00.000Z');
    const check1 = evaluatePostingWindow(at2005, '20:00,22:00', 'Asia/Kolkata');
    assert.equal(check1.isWithinWindow, true);
    assert.equal(check1.scheduleSlot, '20:00');
    assert.equal(check1.diffMinutes, 5);

    // 22:15 IST (16:45 UTC)
    const at2215 = new Date('2026-09-18T16:45:00.000Z');
    const check2 = evaluatePostingWindow(at2215, '20:00,22:00', 'Asia/Kolkata');
    assert.equal(check2.isWithinWindow, true);
    assert.equal(check2.scheduleSlot, '22:00');
    assert.equal(check2.diffMinutes, 15);

    // 14:00 IST (08:30 UTC) - outside both windows
    const at1400 = new Date('2026-09-18T08:30:00.000Z');
    const check3 = evaluatePostingWindow(at1400, '20:00,22:00', 'Asia/Kolkata');
    assert.equal(check3.isWithinWindow, false);
    assert.ok(check3.reason?.includes('outside the posting window'));
  });

  it('10. Settings validation: Enforces comma-separated HH:MM format for daily_posting_times', () => {
    const def = SETTINGS_ALLOWLIST.daily_posting_times;

    assert.equal(validateSettingValue(def, '20:00,22:00'), '20:00,22:00');
    assert.equal(validateSettingValue(def, '08:00, 14:00, 20:00'), '08:00,14:00,20:00');

    assert.throws(
      () => validateSettingValue(def, '25:00,22:00'),
      (err: Error) => {
        assert.match(err.message, /Must be 24-hour HH:MM format/);
        return true;
      }
    );

    assert.throws(
      () => validateSettingValue(def, ''),
      (err: Error) => {
        assert.match(err.message, /must specify at least one time/);
        return true;
      }
    );
  });

  it('11. Settings validation: posts_per_slot and max_daily_posts defaults and bounds', () => {
    assert.equal(SETTINGS_ALLOWLIST.posts_per_slot.defaultValue, 15);
    assert.equal(SETTINGS_ALLOWLIST.max_daily_posts.defaultValue, 30);
    assert.equal(SETTINGS_ALLOWLIST.max_per_batch.defaultValue, 10);

    const slotDef = SETTINGS_ALLOWLIST.posts_per_slot;
    assert.equal(validateSettingValue(slotDef, 15), 15);
    assert.equal(validateSettingValue(slotDef, '20'), 20);

    const maxDailyDef = SETTINGS_ALLOWLIST.max_daily_posts;
    assert.equal(validateSettingValue(maxDailyDef, 30), 30);
  });
});
