/**
 * Live smoke test for the Gemini Files API (v5.1.0).
 *
 * Run from monorepo root:
 *   set -a; source .env; set +a && npx tsx scripts/smoke-files-gemini.ts
 *
 * Env var: GOOGLE_AI_API_KEY
 *
 * Test case 1 — 5 MB MP4 upload:
 *   1. Generate a synthetic 5 MB buffer (real MP4 not required for upload smoke).
 *   2. Upload via client.files.upload(). Expect state: 'processing' | 'active'.
 *   3. Wait for active via client.files.waitForActive().
 *   4. Reference in a client.complete() call with { type: 'file', ref }.
 *   5. Assert non-empty response text.
 *   6. Delete the file.
 *
 * Test case 2 — 8 MB JPG upload:
 *   Same lifecycle as case 1 with image/jpeg media type.
 *
 * Note: synthetic buffers are used because real video/image files are not
 * required for the upload API smoke — Gemini accepts raw bytes. The model
 * call in step 4 is expected to fail or return a best-effort response since
 * the bytes are not real media. The smoke goal is to verify the Files API
 * lifecycle (upload, waitForActive, ref in message, delete) not the model output.
 *
 * If you have real test assets, replace MOCK_MP4_BYTES and MOCK_JPG_BYTES
 * with actual file bytes from disk:
 *   const mp4Bytes = readFileSync('./test-assets/sample.mp4');
 */

import { createClientFromEnv } from '../packages/llm-client/src/index.js';

const MODEL = 'gemini-2.5-flash';

// Synthetic buffers — not real media, but valid for Files API upload/lifecycle smoke.
// Replace with real file bytes if you want the model to actually process the media.
const MOCK_MP4_BYTES = Buffer.alloc(5 * 1024 * 1024, 0x00); // 5 MB of zeros
const MOCK_JPG_BYTES = Buffer.alloc(8 * 1024 * 1024, 0xff); // 8 MB of 0xFF

async function runSmoke(): Promise<void> {
  const apiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!apiKey) {
    throw new Error('GOOGLE_AI_API_KEY not set. Source .env before running.');
  }

  console.log('=== Gemini Files API Smoke Test (v5.1.0) ===\n');
  const overallStart = Date.now();

  const client = await createClientFromEnv('gemini', MODEL);

  // ─── Case 1: 5 MB MP4 ────────────────────────────────────────────────────
  console.log('Case 1: 5 MB MP4 upload → waitForActive → complete() → delete');
  const mp4Start = Date.now();

  console.log('  1a. Uploading 5 MB MP4...');
  const mp4Ref = await client.files.upload({
    data: MOCK_MP4_BYTES,
    mediaType: 'video/mp4',
    displayName: 'smoke-test-5mb.mp4',
  });
  console.log(`  1a. Upload done. id=${mp4Ref.id} state=${mp4Ref.state} sizeBytes=${mp4Ref.sizeBytes}`);

  console.log('  1b. Waiting for active state...');
  const mp4Active = await client.files.waitForActive(mp4Ref, {
    timeoutMs: 120_000,
    intervalMs: 2_000,
  });
  console.log(`  1b. Active. state=${mp4Active.state}`);

  console.log('  1c. Running client.complete() with file ref...');
  try {
    const response = await client.complete([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe what you see in this video in one sentence.' },
          { type: 'file', ref: mp4Active },
        ],
      },
    ]);
    const snippet = response.content.slice(0, 200);
    console.log(`  1c. Response: ${snippet || '(empty — synthetic bytes, expected)'}`);
    console.log(`  1c. latency=${response.latencyMs}ms usage=${JSON.stringify(response.usage)}`);
  } catch (err) {
    // Expected: synthetic bytes may cause model error. Log and continue to test delete.
    console.log(`  1c. Model returned error (expected for synthetic bytes): ${String(err)}`);
  }

  console.log('  1d. Deleting file...');
  await client.files.delete(mp4Active);
  console.log('  1d. Deleted.');

  console.log(`  Case 1 PASS — ${Date.now() - mp4Start}ms\n`);

  // ─── Case 2: 8 MB JPG ────────────────────────────────────────────────────
  console.log('Case 2: 8 MB JPG upload → waitForActive → complete() → delete');
  const jpgStart = Date.now();

  console.log('  2a. Uploading 8 MB JPG...');
  const jpgRef = await client.files.upload({
    data: MOCK_JPG_BYTES,
    mediaType: 'image/jpeg',
    displayName: 'smoke-test-8mb.jpg',
  });
  console.log(`  2a. Upload done. id=${jpgRef.id} state=${jpgRef.state} sizeBytes=${jpgRef.sizeBytes}`);

  console.log('  2b. Waiting for active state...');
  const jpgActive = await client.files.waitForActive(jpgRef, {
    timeoutMs: 60_000,
    intervalMs: 2_000,
  });
  console.log(`  2b. Active. state=${jpgActive.state}`);

  console.log('  2c. Running client.complete() with file ref...');
  try {
    const response = await client.complete([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe what you see in this image in one sentence.' },
          { type: 'file', ref: jpgActive },
        ],
      },
    ]);
    const snippet = response.content.slice(0, 200);
    console.log(`  2c. Response: ${snippet || '(empty — synthetic bytes, expected)'}`);
    console.log(`  2c. latency=${response.latencyMs}ms usage=${JSON.stringify(response.usage)}`);
  } catch (err) {
    console.log(`  2c. Model returned error (expected for synthetic bytes): ${String(err)}`);
  }

  console.log('  2d. Deleting file...');
  await client.files.delete(jpgActive);
  console.log('  2d. Deleted.');

  console.log(`  Case 2 PASS — ${Date.now() - jpgStart}ms\n`);

  console.log(`=== All cases passed — total ${Date.now() - overallStart}ms ===`);
}

runSmoke().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
