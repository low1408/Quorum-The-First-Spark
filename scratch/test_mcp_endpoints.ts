import { handleScoutDiscoverContext, handleConsultCouncilMcq } from '../mcp/server.ts';
import { initSchema } from '../db/database.ts';
import fs from 'fs';
import path from 'path';

// Force use of local database for test
process.env.DATABASE_PATH = './scratch_test.db';
initSchema();

async function runTests() {
  console.log('--- Testing MCQ & Scout Endpoints ---');

  // Test 1: Scout Discover Context
  console.log('\n1. Testing Scout Discover Context...');
  try {
    const scoutResult = await handleScoutDiscoverContext({
      query: 'database sqlite schema',
      repo_root: '.',
      token_budget_chars: 100000,
      enhance_with_llm: false
    });

    console.log('Scout Response Mode:', scoutResult.structuredContent.response_mode);
    console.log('Context Digest:', scoutResult.structuredContent.context_digest);
    console.log('Scouted Files:');
    for (const f of scoutResult.structuredContent.context.files) {
      console.log(`- Path: ${f.path}, Size: ${f.content.length} chars`);
    }
    console.log('✅ Scout Discover Context test passed!');
  } catch (err) {
    console.error('❌ Scout Discover Context test failed:', err);
  }

  // Test 2: MCQ Voting
  console.log('\n2. Testing MCQ voting with Mock provider...');
  try {
    const mcqResult = await handleConsultCouncilMcq({
      question: 'Which database engine should we use?',
      options: [
        { id: 'sqlite', label: 'SQLite', description: 'Simple file-based SQL db' },
        { id: 'postgres', label: 'PostgreSQL', description: 'Powerful server-based SQL db' }
      ],
      providers: ['mock']
    });

    console.log('MCQ Vote Status:', mcqResult.structuredContent.status);
    console.log('Vote Distribution:');
    for (const d of mcqResult.structuredContent.distribution.distribution) {
      console.log(`- Option: ${d.option_id} (${d.option_label}): ${d.vote_count} votes from: ${d.voters.join(', ')}`);
    }
    console.log('✅ MCQ Vote test passed!');
  } catch (err) {
    console.error('❌ MCQ Vote test failed:', err);
  }

  // Cleanup DB
  try {
    const dbPath = path.resolve('./scratch_test.db');
    if (fs.existsSync(dbPath)) {
      const { closeDB } = await import('../db/database.ts');
      closeDB();
      fs.unlinkSync(dbPath);
    }
  } catch (e) {
    console.warn('Could not clean up test db file:', e);
  }
}

runTests().catch(err => {
  console.error('Unexpected error running scratch tests:', err);
  process.exit(1);
});
