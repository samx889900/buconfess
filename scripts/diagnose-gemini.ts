import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

// 1. Load apps/admin/.env if present
try {
  const envPath = path.join(process.cwd(), 'apps', 'admin', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...v] = trimmed.split('=');
        const key = k.trim();
        const val = v.join('=').trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch {}

import { geminiCredentialPool, classifyGeminiError } from '../apps/admin/lib/ai/credentialPool';
import { geminiQuotaLedger } from '../apps/admin/lib/ai/quotaLedger';
import { moderateConfession } from '../apps/admin/lib/ai/moderator';
import { AI_CONFIG, MODERATION_MODELS } from '../apps/admin/lib/ai/config';

async function main() {
  const args = process.argv.slice(2);
  const runLiveProbe = args.includes('--probe');

  console.log('====================================================');
  console.log('       BUCONFESS GEMINI QUOTA & HEALTH DIAGNOSTIC   ');
  console.log('====================================================\n');

  // Synchronize pool and ledger
  geminiCredentialPool.refreshFromEnv();
  const slots = geminiCredentialPool.getSlots();

  console.log('1. CREDENTIAL POOL & PROJECT IDENTITY');
  console.log('------------------------------------');
  if (slots.length === 0) {
    console.log('❌ No Gemini credentials configured in environment.\n');
    return;
  }

  // Map slot IDs to their environment source safely without printing keys
  const envSourceMap: Record<string, string> = {
    'project-1': process.env.GEMINI_API_KEY_1 ? 'GEMINI_API_KEY_1' : 'GEMINI_API_KEY',
    'project-2': 'GEMINI_API_KEY_2',
    'project-3': 'GEMINI_API_KEY_3',
    'project-4': 'GEMINI_API_KEY_4',
    'project-5': 'GEMINI_API_KEY_5',
  };

  for (const slot of slots) {
    const leased = geminiCredentialPool.leaseSlot(slot.id);
    const keyPreview = leased ? `[Configured, length: ${leased.apiKey.length}]` : '[Unavailable]';
    if (leased) {
      geminiCredentialPool.releaseSlot(slot.id, { success: true });
    }
    const envVar = envSourceMap[slot.id] || 'GEMINI_API_KEY_N';
    console.log(`• ${slot.id.padEnd(11)} | Source: ${envVar.padEnd(18)} | Status: ${slot.available ? 'AVAILABLE' : 'COOLDOWN/UNAVAILABLE'} | Key: ${keyPreview}`);
  }

  console.log('\n2. ACTIVE MODEL CASCADE & HIERARCHY');
  console.log('-----------------------------------');
  console.log(`• PRIMARY:            ${MODERATION_MODELS.PRIMARY} (Normal classifier for all confessions)`);
  console.log(`• SECONDARY:          ${MODERATION_MODELS.SECONDARY} (Ambiguity escalation only: confidence < 0.6)`);
  console.log(`• TERTIARY:           ${MODERATION_MODELS.TERTIARY} (Extreme exception only)`);
  console.log(`• RETIRED/DISABLED:   gemini-2.5-flash, gemini-2.5-flash-lite (Permanently removed)`);

  console.log('\n3. LIGHTWEIGHT CAPABILITY & AUTHENTICATION DISCOVERY');
  console.log('----------------------------------------------------');
  console.log('(Performs read-only metadata verification — ZERO content-generation quota consumed)\n');

  interface SlotDiscoveryResult {
    slotId: string;
    httpResult: string;
    authStatus: string;
    quotaStatus: string;
    cooldownStatus: string;
  }

  const discoveryResults: SlotDiscoveryResult[] = [];

  for (const slot of slots) {
    const leased = geminiCredentialPool.leaseSlot(slot.id);
    if (!leased) {
      discoveryResults.push({
        slotId: slot.id,
        httpResult: 'SKIPPED',
        authStatus: 'COOLDOWN',
        quotaStatus: 'IN_COOLDOWN',
        cooldownStatus: `Cooldown active (~${Math.ceil(((slot.cooldownUntil || 0) - Date.now()) / 3600000)}h remaining)`,
      });
      continue;
    }

    const ai = new GoogleGenAI({ apiKey: leased.apiKey });
    try {
      // Lightweight read-only capability check using models.get
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout after 4000ms')), 4000)
      );
      const getPromise = (ai.models as any).get({ model: `models/${MODERATION_MODELS.PRIMARY}` });
      await Promise.race([getPromise, timeoutPromise]);

      discoveryResults.push({
        slotId: slot.id,
        httpResult: 'HTTP 200 OK',
        authStatus: 'VALID',
        quotaStatus: 'AVAILABLE',
        cooldownStatus: 'HEALTHY',
      });
      geminiCredentialPool.releaseSlot(slot.id, { success: true });
    } catch (err: any) {
      const classification = classifyGeminiError(err);
      let httpResult = 'ERROR';
      let authStatus = 'UNKNOWN';
      let quotaStatus = 'UNKNOWN';
      let cooldownStatus = 'HEALTHY';

      if (classification === 'AUTHENTICATION') {
        httpResult = 'HTTP 401';
        authStatus = 'INVALID_API_KEY';
        cooldownStatus = 'PERMANENTLY_DISABLED';
      } else if (classification === 'PERMISSION') {
        httpResult = 'HTTP 403';
        authStatus = 'PERMISSION_DENIED';
        cooldownStatus = 'PERMANENTLY_DISABLED';
      } else if (classification === 'DAILY_QUOTA_EXHAUSTED') {
        httpResult = 'HTTP 429';
        authStatus = 'VALID';
        quotaStatus = 'DAILY_EXHAUSTED';
        cooldownStatus = 'COOLDOWN_PACIFIC_MIDNIGHT';
      } else if (classification === 'SERVICE_UNAVAILABLE') {
        httpResult = 'HTTP 503';
        authStatus = 'VALID';
        quotaStatus = 'SERVICE_UNAVAILABLE';
        cooldownStatus = 'COOLDOWN_60S';
      } else if (classification === 'TIMEOUT') {
        httpResult = 'TIMEOUT';
        authStatus = 'VALID';
        quotaStatus = 'DEADLINE_EXCEEDED';
        cooldownStatus = 'COOLDOWN_30S';
      } else {
        httpResult = err.status ? `HTTP ${err.status}` : 'ERR';
        authStatus = 'ERROR';
        quotaStatus = err.message || 'UNKNOWN';
      }

      discoveryResults.push({
        slotId: slot.id,
        httpResult,
        authStatus,
        quotaStatus,
        cooldownStatus,
      });

      geminiCredentialPool.releaseSlot(slot.id, { success: false, error: err });
    }
  }

  // Display Table
  console.log(`${'Slot'.padEnd(12)} ${'HTTP Result'.padEnd(14)} ${'Auth'.padEnd(16)} ${'Quota Status'.padEnd(18)} ${'Cooldown / Health'.padEnd(20)}`);
  console.log(`${'-'.repeat(12)} ${'-'.repeat(14)} ${'-'.repeat(16)} ${'-'.repeat(18)} ${'-'.repeat(20)}`);
  for (const r of discoveryResults) {
    console.log(`${r.slotId.padEnd(12)} ${r.httpResult.padEnd(14)} ${r.authStatus.padEnd(16)} ${r.quotaStatus.padEnd(18)} ${r.cooldownStatus.padEnd(20)}`);
  }

  console.log('\n4. REQUEST BUDGETING & QUOTA LEDGER');
  console.log('-----------------------------------');
  console.log(`• Observed Provider Free-Tier Limit:   ${AI_CONFIG.quota.freeTierObservedLimit} RPD per model per project`);
  console.log(`• Conservative Safety Budget:          ${AI_CONFIG.quota.dailyBudgetPerModel} RPD per model per project`);
  console.log(`• Reserved Safety Margin:              ${AI_CONFIG.quota.safetyMargin} requests (Never deliberately consumed)\n`);

  const ledgerSummary = geminiQuotaLedger.getLedgerSummary();
  console.log(`${'Project'.padEnd(12)} ${'Model'.padEnd(20)} ${'Used/Budget'.padEnd(14)} ${'Remaining'.padEnd(12)} ${'503'.padEnd(6)} ${'429'.padEnd(6)} ${'Status'.padEnd(12)}`);
  console.log(`${'-'.repeat(12)} ${'-'.repeat(20)} ${'-'.repeat(14)} ${'-'.repeat(12)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(12)}`);

  for (const proj of ledgerSummary.projects) {
    for (const [model, stats] of Object.entries(proj.models)) {
      const usedBudget = `${stats.requestsToday}/${stats.dailyBudget}`;
      console.log(
        `${proj.projectKey.padEnd(12)} ${model.padEnd(20)} ${usedBudget.padEnd(14)} ${String(stats.remainingBudget).padEnd(12)} ${String(stats.count503).padEnd(6)} ${String(stats.count429).padEnd(6)} ${stats.healthStatus.padEnd(12)}`
      );
    }
  }

  console.log('\n5. HOW MANY REQUESTS CAN WE SAFELY MAKE RIGHT NOW?');
  console.log('--------------------------------------------------');
  const safePrimary = ledgerSummary.totalSafeRequestsAvailable.primary;
  const safeSecondary = ledgerSummary.totalSafeRequestsAvailable.secondary;
  const safeTertiary = ledgerSummary.totalSafeRequestsAvailable.tertiary;

  console.log(`✅ PRIMARY   (${MODERATION_MODELS.PRIMARY}):    ${safePrimary} safe requests available across healthy project slots`);
  console.log(`   SECONDARY (${MODERATION_MODELS.SECONDARY}):    ${safeSecondary} safe requests available (ambiguity escalation only)`);
  console.log(`   TERTIARY  (${MODERATION_MODELS.TERTIARY}):     ${safeTertiary} safe requests available (extreme exception only)`);

  if (safePrimary === 0) {
    console.log('\n⚠️ CAUTION: All primary model project slots are currently at daily budget limit or in cooldown.');
    console.log('   Do NOT start large moderation batches until reset.');
  } else {
    console.log(`\n🚀 The system is READY to moderate up to ${safePrimary} confessions with 1-call-per-decision efficiency.`);
  }

  // 6. Optional Single Live Probe
  if (runLiveProbe) {
    console.log('\n6. CONTROLLED LIVE PROBE');
    console.log('------------------------');
    console.log('⚠️ [CONSUMES 1 QUOTA REQUEST ON PRIMARY MODEL gemini-3.5-flash]');

    const startTime = Date.now();
    try {
      const probeResult = await moderateConfession(
        'Excited for the upcoming campus sports fest! Great vibes all around.',
        {
          skipDeterministicRules: true,
          confessionId: 'diag_probe',
          modelCascade: [MODERATION_MODELS.PRIMARY],
        }
      );
      const durationMs = Date.now() - startTime;
      console.log(`• Result:          ${probeResult.verdict.toUpperCase()}`);
      console.log(`• Model Used:      ${probeResult.model_id}`);
      console.log(`• Confidence:      ${probeResult.model_confidence !== null ? `${(probeResult.model_confidence * 100).toFixed(0)}%` : 'null'}`);
      console.log(`• Latency:         ${durationMs}ms`);
      console.log(`• Telemetry:       ${probeResult.telemetry?.length ?? 1} call(s) made`);
      console.log('✅ Single live probe succeeded with structured output validation!');
    } catch (probeErr: any) {
      console.error('❌ Live probe failed:', probeErr.message);
    }
  } else {
    console.log('\n(Note: Live probe was skipped to preserve quota. Pass --probe to execute a single live probe)');
  }

  console.log('\n====================================================');
  console.log('Zero production state mutated. Zero secrets exposed.');
  console.log('====================================================\n');
}

main().catch(console.error);
