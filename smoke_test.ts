// Dynamically set environment database path before loading modules
process.env.DATABASE_PATH = './smoke_test_orchestrator.db';

import { initSchema, getDB } from './db/database.ts';
import { runCouncilConsultation, type CouncilConsultationRequest } from './engine/council.ts';
import { validateCouncilContext } from './mcp/contextValidation.ts';
import fs from 'fs';
import path from 'path';

async function runSmokeTest() {
  console.log('--- Starting Quorum API Slice Smoke Test ---');

  // Initialize SQLite Database schema
  console.log('Initializing SQLite database schema...');
  initSchema();
  console.log('Database initialized successfully.');

  // Create a temporary mock context file on disk for freshness-check validation
  const testFilePath = path.resolve('./temp_test_file.ts');
  const fileContent = 'export function test() { return "hello world"; }';
  fs.writeFileSync(testFilePath, fileContent, 'utf8');

  try {
    // Construct a ValidatedCouncilContext
    console.log('Validating request context...');
    const rawContext = {
      files: [
        {
          path: 'temp_test_file.ts',
          content: fileContent,
          relevance: 'Core test logic file',
          start_line: 1,
          end_line: 1,
          total_lines: 1,
          is_excerpt: false
        }
      ],
      notes: 'This is a smoke test notes payload.',
      structured_review: {
        review_objective: 'Verify the browserless council validation and consensus flows.',
        architecture: 'Mock architecture for testing.',
        execution_flow: 'Run smoke test execution flow.',
        assumptions_and_invariants: 'All providers are mock or API calls.',
        core_evidence: 'temp_test_file.ts',
        supporting_contracts: 'None.',
        privacy_and_persistence: 'Temporary db file.',
        tests_and_runtime_evidence: 'Console outputs of smoke_test.ts.',
        omitted_material: 'None.'
      }
    };

    const validatedContext = validateCouncilContext(rawContext, 'Explain this test code.', {
      workspaceRoot: '.'
    });

    console.log('Validated Context Digest:', validatedContext.context_digest);

    // Run Council Consultation with the "mock" provider
    const request: CouncilConsultationRequest = {
      question: 'Explain this test code.',
      context: validatedContext,
      providers: ['mock'], // uses our native ApiRunner mock branch
      maxConcurrency: 1
    };

    console.log('Running Council consultation...');
    const result = await runCouncilConsultation(request);

    console.log('\n--- Consultation Result ---');
    console.log('Run ID:', result.run_id);
    console.log('Status:', result.status);
    console.log('Warnings:', result.warnings);
    console.log('Report:\n', result.report);

    // Verify database records
    console.log('Verifying SQLite audit trail records...');
    const db = getDB();
    const targetRun = db.prepare('SELECT * FROM Runs WHERE run_id = ?').get(result.run_id) as any;

    if (!targetRun) {
      throw new Error(`Smoke Test FAILED: Run ${result.run_id} not found in database.`);
    }

    console.log(`Verified DB Run ID: ${targetRun.run_id}, Status: ${targetRun.status}`);
    
    const tasks = db.prepare('SELECT * FROM Tasks WHERE run_id = ?').all(result.run_id) as any[];
    console.log(`Tasks for run: ${tasks.length}`);
    for (const t of tasks) {
      console.log(`- Task ID: ${t.task_id}, Provider: ${t.provider_name}, Status: ${t.status}`);
    }

    console.log('\n✅ SMOKE TEST PASSED SUCCESSFULLY!');
  } finally {
    // Clean up temporary test file
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    // Clean up temporary database
    try {
      const dbPath = path.resolve('./smoke_test_orchestrator.db');
      if (fs.existsSync(dbPath)) {
        // Wait briefly for sqlite to close connections
        const { closeDB } = await import('./db/database.ts');
        closeDB();
        fs.unlinkSync(dbPath);
      }
    } catch (e) {
      console.warn('Could not clean up temporary db file:', e);
    }
  }
}

runSmokeTest().catch(err => {
  console.error('\n❌ SMOKE TEST FAILED:', err);
  process.exit(1);
});
