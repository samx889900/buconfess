import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { syncConfessionToSheets, retryPendingSheetsSync } from '../apps/admin/lib/sheets/syncService';

describe('Secondary Google Sheets Sync & Idempotency (v3.5)', () => {
  it('1. Sync is idempotent: Updates existing row instead of adding duplicate row', async () => {
    const sheetRows: any[] = [];
    const mockSheet = {
      getRows: async () => sheetRows,
      addRow: async (data: any) => {
        const row = {
          ...data,
          save: async () => {},
        };
        sheetRows.push(row);
        return row;
      },
    };
    const mockDoc = { sheetsByIndex: [mockSheet] };

    let dbUpdatedStatus = '';
    const mockSupabase = {
      from: (table: string) => ({
        update: (payload: any) => {
          dbUpdatedStatus = payload.sheets_sync_status;
          return {
            eq: async () => ({ error: null }),
          };
        },
        upsert: async () => ({ error: null }),
      }),
    } as any;

    const confession = {
      id: 42,
      number: 10,
      text: 'Campus night canteen pizza is the best!',
      status: 'posted',
      ig_post_id: 'ig_post_123456',
      ig_permalink: 'https://instagram.com/p/abc123xyz',
      posted_at: '2026-09-18T10:00:00Z',
      created_at: '2026-09-18T08:00:00Z',
    };

    // 1st sync: appends row
    const firstResult = await syncConfessionToSheets(confession, {
      supabaseClient: mockSupabase,
      sheetDocMock: mockDoc,
    });
    assert.equal(firstResult.success, true);
    assert.equal(firstResult.isExistingRow, false);
    assert.equal(sheetRows.length, 1);
    assert.equal(dbUpdatedStatus, 'synced');

    // 2nd sync of the same confession: updates existing row, row count stays 1
    const secondResult = await syncConfessionToSheets(confession, {
      supabaseClient: mockSupabase,
      sheetDocMock: mockDoc,
    });
    assert.equal(secondResult.success, true);
    assert.equal(secondResult.isExistingRow, true);
    assert.equal(sheetRows.length, 1, 'Idempotency invariant: must not create duplicate row');
  });

  it('2. Sheets failure leaves confession posted and never rolls back Instagram state', async () => {
    const failingMockDoc = {
      sheetsByIndex: [
        {
          getRows: async () => {
            throw new Error('Google API Quota Exceeded (429)');
          },
        },
      ],
    };

    let updatedFields: Record<string, any> = {};
    const mockSupabase = {
      from: (table: string) => ({
        update: (payload: any) => {
          updatedFields = payload;
          return {
            eq: async () => ({ error: null }),
          };
        },
        upsert: async () => ({ error: null }),
      }),
    } as any;

    const confession = {
      id: 43,
      number: 11,
      text: 'Good luck with midterms everyone!',
      status: 'posted',
      ig_post_id: 'ig_post_999999',
      ig_permalink: 'https://instagram.com/p/goodluck',
      posted_at: '2026-09-18T11:00:00Z',
      created_at: '2026-09-18T09:00:00Z',
    };

    const res = await syncConfessionToSheets(confession, {
      supabaseClient: mockSupabase,
      sheetDocMock: failingMockDoc,
    });

    assert.equal(res.success, false);
    assert.equal(res.confessionId, 43);
    assert.ok(res.error?.includes('Google API Quota Exceeded'));

    // Critical Invariant: sheets_sync_status is failed, but status is NEVER rolled back
    assert.equal(updatedFields.sheets_sync_status, 'failed');
    assert.ok(updatedFields.sheets_sync_error?.includes('Google API Quota Exceeded'));
    assert.equal(updatedFields.status, undefined, 'Confession status must never be modified or rolled back on Sheets failure');
  });

  it('3. Retries pending/failed sheets sync for posted confessions', async () => {
    const sheetRows: any[] = [];
    const mockSheet = {
      getRows: async () => sheetRows,
      addRow: async (data: any) => {
        sheetRows.push(data);
        return data;
      },
    };
    const mockDoc = { sheetsByIndex: [mockSheet] };

    const mockPendingConfessions = [
      {
        id: 50,
        number: 12,
        text: 'Confession 50',
        status: 'posted',
        ig_post_id: 'ig_50',
        sheets_sync_status: 'failed',
      },
      {
        id: 51,
        number: 13,
        text: 'Confession 51',
        status: 'posted',
        ig_post_id: 'ig_51',
        sheets_sync_status: 'pending',
      },
    ];

    const mockSupabase = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            neq: () => ({
              is: () => ({
                order: () => ({
                  limit: async () => ({
                    data: mockPendingConfessions,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        }),
        update: () => ({
          eq: async () => ({ error: null }),
        }),
        upsert: async () => ({ error: null }),
      }),
    } as any;

    const retryResult = await retryPendingSheetsSync(10, {
      supabaseClient: mockSupabase,
      sheetDocMock: mockDoc,
    });

    assert.equal(retryResult.processed, 2);
    assert.equal(retryResult.synced, 2);
    assert.equal(retryResult.failed, 0);
    assert.equal(sheetRows.length, 2);
  });
});
