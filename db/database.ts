import Database from 'better-sqlite3';
import { config } from '../config/index.ts';
import type { RunStatus } from '../engine/statuses.ts';
import type { FailureCode } from '../engine/failures.ts';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

let _db: any = null;

/**
 * Lazily initializes and returns the active database connection.
 * Supports dynamic path modification (e.g. during offline unit tests).
 */
export function getDB() {
  if (!_db) {
    const dbDir = path.dirname(config.databasePath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    _db = new Database(config.databasePath);
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');
  }
  return _db;
}

/**
 * Closes the active database connection and resets the singleton instance.
 */
export function closeDB() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function repairLegacyTasksRunForeignKey(db: any): void {
  const tasksSchema = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='Tasks'").get() as any;
  if (!tasksSchema?.sql || !tasksSchema.sql.includes('Runs_old')) {
    return;
  }

  db.pragma('foreign_keys = OFF');

  try {
    db.transaction(() => {
      const lineageSchema = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='Lineage'").get() as any;

      if (lineageSchema?.sql) {
        db.prepare('ALTER TABLE Lineage RENAME TO Lineage_legacy_bad_fk').run();
      }

      db.prepare('ALTER TABLE Tasks RENAME TO Tasks_legacy_bad_fk').run();

      db.prepare(`
        CREATE TABLE Tasks (
          task_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
          provider_name TEXT NOT NULL,
          prompt_payload TEXT NOT NULL,
          response_text TEXT,
          extraction_method TEXT CHECK(extraction_method IN ('clean', 'timeout_forced', 'manual', 'api')),
          status TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      db.prepare(`
        INSERT INTO Tasks (
          task_id,
          run_id,
          provider_name,
          prompt_payload,
          response_text,
          extraction_method,
          status,
          created_at
        )
        SELECT
          task_id,
          run_id,
          provider_name,
          prompt_payload,
          response_text,
          extraction_method,
          status,
          created_at
        FROM Tasks_legacy_bad_fk
        WHERE run_id IN (SELECT run_id FROM Runs)
      `).run();

      db.prepare('DROP TABLE Tasks_legacy_bad_fk').run();

      if (lineageSchema?.sql) {
        db.prepare(`
          CREATE TABLE Lineage (
            parent_task_id TEXT NOT NULL REFERENCES Tasks(task_id) ON DELETE CASCADE,
            child_task_id TEXT NOT NULL REFERENCES Tasks(task_id) ON DELETE CASCADE,
            PRIMARY KEY (parent_task_id, child_task_id)
          )
        `).run();

        db.prepare(`
          INSERT OR IGNORE INTO Lineage (parent_task_id, child_task_id)
          SELECT parent_task_id, child_task_id
          FROM Lineage_legacy_bad_fk
          WHERE parent_task_id IN (SELECT task_id FROM Tasks)
            AND child_task_id IN (SELECT task_id FROM Tasks)
        `).run();

        db.prepare('DROP TABLE Lineage_legacy_bad_fk').run();
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new Error(`Database foreign key repair left ${violations.length} violation(s).`);
  }
}

function repairAllLegacyForeignKeys(db: any): void {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all() as { name: string; sql: string }[];
  
  const hasBadFk = tables.some(t => 
    t.sql && (
      t.sql.includes('Runs_old') || 
      t.sql.includes('NodeInvocations_old') || 
      t.sql.includes('Artifacts_legacy_bad_fk') ||
      t.sql.includes('NodeInvocations_legacy_bad_fk') ||
      t.sql.includes('_legacy_bad_fk')
    )
  ) || tables.some(t => t.name.includes('_old') || t.name.includes('_legacy_bad_fk'));

  if (!hasBadFk) {
    return;
  }

  console.log('Detected bad legacy foreign key references or backup tables. Initiating full database schema repair...');
  
  db.pragma('foreign_keys = OFF');

  try {
    db.transaction(() => {
      // 1. Rename existing tables to avoid conflicts
      const targetTables = [
        'RunInputs',
        'Artifacts',
        'NodeInvocations',
        'TaskAttempts',
        'ArtifactLineage',
        'HumanReviewEvents',
        'SummaryEvaluationMetrics'
      ];

      for (const table of targetTables) {
        const exists = tables.some(t => t.name === table);
        if (exists) {
          db.prepare(`DROP TABLE IF EXISTS ${table}_legacy_bad_fk`).run();
          db.prepare(`ALTER TABLE ${table} RENAME TO ${table}_legacy_bad_fk`).run();
        }
      }

      // 2. Recreate all tables with correct FK schemas
      
      // RunInputs
      db.prepare(`
        CREATE TABLE RunInputs (
          run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
          input_name TEXT NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY (run_id, input_name)
        )
      `).run();

      // Artifacts
      db.prepare(`
        CREATE TABLE Artifacts (
          artifact_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
          node_id TEXT,
          artifact_type TEXT NOT NULL CHECK(artifact_type IN ('input', 'raw_output', 'reviewed_output', 'synthesis')),
          content_json TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      // NodeInvocations
      db.prepare(`
        CREATE TABLE NodeInvocations (
          invocation_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          iteration_no INTEGER DEFAULT 1,
          status TEXT NOT NULL CHECK(status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'AWAITING_HUMAN_REVIEW', 'INTERVENTION_REQUIRED')),
          required_for_run_success INTEGER DEFAULT 1 CHECK(required_for_run_success IN (0, 1)),
          failure_policy TEXT DEFAULT 'fail_run' CHECK(failure_policy IN ('fail_run', 'skip_branch', 'continue_with_warning')),
          input_snapshot_json TEXT,
          output_artifact_id TEXT REFERENCES Artifacts(artifact_id) ON DELETE SET NULL,
          error_message TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (run_id, node_id)
        )
      `).run();

      // TaskAttempts
      db.prepare(`
        CREATE TABLE TaskAttempts (
          attempt_id TEXT PRIMARY KEY,
          invocation_id TEXT NOT NULL REFERENCES NodeInvocations(invocation_id) ON DELETE CASCADE,
          attempt_no INTEGER NOT NULL,
          provider_name TEXT NOT NULL,
          prompt_payload TEXT NOT NULL,
          response_text TEXT,
          status TEXT NOT NULL CHECK(status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERVENTION_REQUIRED')),
          error_message TEXT,
          started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP,
          thread_url TEXT,
          context_mode TEXT,
          context_fidelity TEXT,
          adapter_state_json TEXT
        )
      `).run();

      // ArtifactLineage
      db.prepare(`
        CREATE TABLE ArtifactLineage (
          parent_artifact_id TEXT NOT NULL REFERENCES Artifacts(artifact_id) ON DELETE CASCADE,
          child_invocation_id TEXT NOT NULL REFERENCES NodeInvocations(invocation_id) ON DELETE CASCADE,
          PRIMARY KEY (parent_artifact_id, child_invocation_id)
        )
      `).run();

      // HumanReviewEvents
      db.prepare(`
        CREATE TABLE HumanReviewEvents (
          review_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
          node_id TEXT NOT NULL,
          invocation_id TEXT NOT NULL REFERENCES NodeInvocations(invocation_id) ON DELETE CASCADE,
          raw_artifact_id TEXT NOT NULL REFERENCES Artifacts(artifact_id) ON DELETE CASCADE,
          reviewed_artifact_id TEXT REFERENCES Artifacts(artifact_id) ON DELETE SET NULL,
          decision TEXT NOT NULL CHECK(decision IN ('APPROVED', 'EDITED', 'REJECTED')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      // SummaryEvaluationMetrics
      db.prepare(`
        CREATE TABLE SummaryEvaluationMetrics (
          metric_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
          round_no INTEGER NOT NULL DEFAULT 1,
          summary_task_id TEXT,
          defender_task_id TEXT,
          summary_artifact_id TEXT REFERENCES Artifacts(artifact_id) ON DELETE SET NULL,
          defender_artifact_id TEXT REFERENCES Artifacts(artifact_id) ON DELETE SET NULL,
          defender_label TEXT NOT NULL,
          coverage_score REAL NOT NULL,
          omission_score REAL NOT NULL,
          distortion_score REAL NOT NULL,
          contradiction_score REAL NOT NULL,
          verdict_accuracy REAL NOT NULL,
          key_claims_total INTEGER NOT NULL,
          key_claims_preserved INTEGER NOT NULL,
          key_claims_omitted INTEGER NOT NULL,
          key_claims_distorted INTEGER NOT NULL,
          key_claims_contradicted INTEGER NOT NULL,
          rouge1_f1 REAL NOT NULL,
          rouge2_f1 REAL NOT NULL,
          rouge_l_f1 REAL NOT NULL,
          evaluator_provider TEXT,
          evaluator_task_id TEXT,
          evaluator_response_json TEXT,
          evaluator_rationale TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      // 3. Copy data from legacy tables back to correct tables, filtering by valid parent/reference existence
      
      // RunInputs
      if (tables.some(t => t.name === 'RunInputs')) {
        db.prepare(`
          INSERT OR IGNORE INTO RunInputs (run_id, input_name, value_json)
          SELECT run_id, input_name, value_json
          FROM RunInputs_legacy_bad_fk
          WHERE run_id IN (SELECT run_id FROM Runs)
        `).run();
      }

      // Artifacts
      if (tables.some(t => t.name === 'Artifacts')) {
        db.prepare(`
          INSERT OR IGNORE INTO Artifacts (artifact_id, run_id, node_id, artifact_type, content_json, created_at)
          SELECT artifact_id, run_id, node_id, artifact_type, content_json, created_at
          FROM Artifacts_legacy_bad_fk
          WHERE run_id IN (SELECT run_id FROM Runs)
        `).run();
      }

      // NodeInvocations
      if (tables.some(t => t.name === 'NodeInvocations')) {
        db.prepare(`
          INSERT OR IGNORE INTO NodeInvocations (
            invocation_id, run_id, node_id, iteration_no, status, required_for_run_success,
            failure_policy, input_snapshot_json, output_artifact_id, error_message, created_at, updated_at
          )
          SELECT 
            invocation_id, run_id, node_id, iteration_no, status, required_for_run_success,
            failure_policy, input_snapshot_json, output_artifact_id, error_message, created_at, updated_at
          FROM NodeInvocations_legacy_bad_fk
          WHERE run_id IN (SELECT run_id FROM Runs)
            AND (output_artifact_id IS NULL OR output_artifact_id IN (SELECT artifact_id FROM Artifacts))
        `).run();
      }

      // TaskAttempts
      if (tables.some(t => t.name === 'TaskAttempts')) {
        db.prepare(`
          INSERT OR IGNORE INTO TaskAttempts (
            attempt_id, invocation_id, attempt_no, provider_name, prompt_payload, response_text,
            status, error_message, started_at, completed_at, thread_url, context_mode, context_fidelity, adapter_state_json
          )
          SELECT 
            attempt_id, invocation_id, attempt_no, provider_name, prompt_payload, response_text,
            status, error_message, started_at, completed_at, thread_url, context_mode, context_fidelity, adapter_state_json
          FROM TaskAttempts_legacy_bad_fk
          WHERE invocation_id IN (SELECT invocation_id FROM NodeInvocations)
        `).run();
      }

      // ArtifactLineage
      if (tables.some(t => t.name === 'ArtifactLineage')) {
        db.prepare(`
          INSERT OR IGNORE INTO ArtifactLineage (parent_artifact_id, child_invocation_id)
          SELECT parent_artifact_id, child_invocation_id
          FROM ArtifactLineage_legacy_bad_fk
          WHERE parent_artifact_id IN (SELECT artifact_id FROM Artifacts)
            AND child_invocation_id IN (SELECT invocation_id FROM NodeInvocations)
        `).run();
      }

      // HumanReviewEvents
      if (tables.some(t => t.name === 'HumanReviewEvents')) {
        db.prepare(`
          INSERT OR IGNORE INTO HumanReviewEvents (
            review_id, run_id, node_id, invocation_id, raw_artifact_id, reviewed_artifact_id, decision, created_at
          )
          SELECT 
            review_id, run_id, node_id, invocation_id, raw_artifact_id, reviewed_artifact_id, decision, created_at
          FROM HumanReviewEvents_legacy_bad_fk
          WHERE run_id IN (SELECT run_id FROM Runs)
            AND invocation_id IN (SELECT invocation_id FROM NodeInvocations)
            AND raw_artifact_id IN (SELECT artifact_id FROM Artifacts)
            AND (reviewed_artifact_id IS NULL OR reviewed_artifact_id IN (SELECT artifact_id FROM Artifacts))
        `).run();
      }

      // SummaryEvaluationMetrics
      if (tables.some(t => t.name === 'SummaryEvaluationMetrics')) {
        db.prepare(`
          INSERT OR IGNORE INTO SummaryEvaluationMetrics (
            metric_id, run_id, round_no, summary_task_id, defender_task_id,
            summary_artifact_id, defender_artifact_id, defender_label,
            coverage_score, omission_score, distortion_score, contradiction_score,
            verdict_accuracy, key_claims_total, key_claims_preserved,
            key_claims_omitted, key_claims_distorted, key_claims_contradicted,
            rouge1_f1, rouge2_f1, rouge_l_f1, evaluator_provider,
            evaluator_task_id, evaluator_response_json, evaluator_rationale,
            created_at
          )
          SELECT
            metric_id, run_id, round_no, summary_task_id, defender_task_id,
            summary_artifact_id, defender_artifact_id, defender_label,
            coverage_score, omission_score, distortion_score, contradiction_score,
            verdict_accuracy, key_claims_total, key_claims_preserved,
            key_claims_omitted, key_claims_distorted, key_claims_contradicted,
            rouge1_f1, rouge2_f1, rouge_l_f1, evaluator_provider,
            evaluator_task_id, evaluator_response_json, evaluator_rationale,
            created_at
          FROM SummaryEvaluationMetrics_legacy_bad_fk
          WHERE run_id IN (SELECT run_id FROM Runs)
            AND (summary_artifact_id IS NULL OR summary_artifact_id IN (SELECT artifact_id FROM Artifacts))
            AND (defender_artifact_id IS NULL OR defender_artifact_id IN (SELECT artifact_id FROM Artifacts))
        `).run();
      }

      // 4. Drop all legacy tables
      for (const table of targetTables) {
        db.prepare(`DROP TABLE IF EXISTS ${table}_legacy_bad_fk`).run();
      }

      // Cleanup Runs_old and NodeInvocations_old if they exist
      db.prepare('DROP TABLE IF EXISTS Runs_old').run();
      db.prepare('DROP TABLE IF EXISTS NodeInvocations_old').run();
      console.log('Schema repair transaction committed successfully.');
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    console.warn(`WARNING: Database foreign key repair left ${violations.length} violation(s).`);
  }
}

/**
 * Initializes the database schema exactly as described in the blueprint.
 */
export function initSchema() {
  const db = getDB();
  repairLegacyTasksRunForeignKey(db);
  repairAllLegacyForeignKeys(db);

  db.transaction(() => {
    // Phase 0 visual orchestrator design tables.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS WorkflowTemplates (
        workflow_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS WorkflowInputDefinitions (
        input_def_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES WorkflowTemplates(workflow_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('string', 'number', 'file')),
        required INTEGER DEFAULT 1 CHECK(required IN (0, 1)),
        default_value_json TEXT,
        description TEXT
      )
    `).run();

    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_inputs_unique_name
      ON WorkflowInputDefinitions(workflow_id, name)
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS WorkflowDrafts (
        workflow_id TEXT PRIMARY KEY REFERENCES WorkflowTemplates(workflow_id) ON DELETE CASCADE,
        graph_json TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS CompiledWorkflowVersions (
        workflow_version_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES WorkflowTemplates(workflow_id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        source_graph_json TEXT NOT NULL,
        compiled_plan_json TEXT NOT NULL,
        validation_report_json TEXT,
        compiler_version TEXT NOT NULL,
        compiled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_compiled_workflow_versions_no
      ON CompiledWorkflowVersions(workflow_id, version_no)
    `).run();

    db.prepare(`
      CREATE TRIGGER IF NOT EXISTS prevent_compiled_version_update
      BEFORE UPDATE ON CompiledWorkflowVersions
      BEGIN
        SELECT RAISE(ABORT, 'Compiled workflow versions are immutable and cannot be updated');
      END
    `).run();

    db.prepare(`
      CREATE TRIGGER IF NOT EXISTS prevent_compiled_version_delete
      BEFORE DELETE ON CompiledWorkflowVersions
      BEGIN
        SELECT RAISE(ABORT, 'Compiled workflow versions are immutable and cannot be deleted');
      END
    `).run();

    // 1. Runs Table
    try {
      const runsSchema = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='Runs'").get() as any;
      if (runsSchema && (!runsSchema.sql.includes('AWAITING_HUMAN_REVIEW') || !runsSchema.sql.includes('INTERVENTION_REQUIRED') || !runsSchema.sql.includes('CANCELLED') || !runsSchema.sql.includes('updated_at'))) {
        db.prepare("ALTER TABLE Runs RENAME TO Runs_old").run();
        db.prepare(`
          CREATE TABLE Runs (
            run_id TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            status TEXT DEFAULT 'IN_PROGRESS' CHECK(status IN ('IN_PROGRESS', 'COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED', 'AWAITING_HUMAN_REVIEW', 'INTERVENTION_REQUIRED')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `).run();
        
        // Check if old table had workflow_version_id
        const runsInfo = db.prepare("PRAGMA table_info(Runs_old)").all() as any[];
        const hasWfVerId = runsInfo.some((col: any) => col.name === 'workflow_version_id');
        if (hasWfVerId) {
          db.prepare("ALTER TABLE Runs ADD COLUMN workflow_version_id TEXT REFERENCES CompiledWorkflowVersions(workflow_version_id) ON DELETE SET NULL").run();
          db.prepare(`
            INSERT INTO Runs (run_id, topic, status, created_at, updated_at, workflow_version_id)
            SELECT run_id, topic, status, created_at, created_at, workflow_version_id FROM Runs_old
          `).run();
        } else {
          db.prepare(`
            INSERT INTO Runs (run_id, topic, status, created_at, updated_at)
            SELECT run_id, topic, status, created_at, created_at FROM Runs_old
          `).run();
        }
        db.prepare("DROP TABLE Runs_old").run();
      }
    } catch (e) {
      // Ignore
    }

    db.prepare(`
      CREATE TABLE IF NOT EXISTS Runs (
        run_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        status TEXT DEFAULT 'IN_PROGRESS' CHECK(status IN ('IN_PROGRESS', 'COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED', 'AWAITING_HUMAN_REVIEW', 'INTERVENTION_REQUIRED')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // Check if workflow_version_id needs to be added to Runs
    const runsInfo = db.prepare("PRAGMA table_info(Runs)").all() as any[];
    const hasWorkflowVersionId = runsInfo.some((col: any) => col.name === 'workflow_version_id');
    if (!hasWorkflowVersionId) {
      db.prepare("ALTER TABLE Runs ADD COLUMN workflow_version_id TEXT REFERENCES CompiledWorkflowVersions(workflow_version_id) ON DELETE SET NULL").run();
    }

    // 2. Tasks Table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS Tasks (
        task_id TEXT PRIMARY KEY, -- Used as the BullMQ Idempotency Key
        run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
        provider_name TEXT NOT NULL,
        prompt_payload TEXT NOT NULL,
        response_text TEXT, 
        extraction_method TEXT CHECK(extraction_method IN ('clean', 'timeout_forced', 'manual', 'api')),
        status TEXT NOT NULL,
        attempt_no INTEGER DEFAULT 1,
        failure_code TEXT,
        submission_confirmed INTEGER DEFAULT 0 CHECK(submission_confirmed IN (0, 1)),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    const taskColumns = db.prepare("PRAGMA table_info(Tasks)").all() as any[];
    const taskColumnNames = new Set(taskColumns.map(col => col.name));
    for (const [columnName, columnType] of [
      ['attempt_no', 'INTEGER DEFAULT 1'],
      ['failure_code', 'TEXT'],
      ['submission_confirmed', 'INTEGER DEFAULT 0 CHECK(submission_confirmed IN (0, 1))']
    ]) {
      if (!taskColumnNames.has(columnName)) {
        db.prepare(`ALTER TABLE Tasks ADD COLUMN ${columnName} ${columnType}`).run();
      }
    }

    db.prepare(`
      CREATE TABLE IF NOT EXISTS McpToolCallMetrics (
        tool_call_id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        run_id TEXT REFERENCES Runs(run_id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK(status IN (
          'RECEIVED',
          'VALIDATION_FAILED',
          'COMPLETED',
          'PARTIAL_SUCCESS',
          'FAILED',
          'CANCELLED',
          'INTERVENTION_REQUIRED'
        )),
        requested_provider_count INTEGER DEFAULT 0,
        successful_provider_count INTEGER DEFAULT 0,
        failed_provider_count INTEGER DEFAULT 0,
        duration_ms INTEGER,
        context_digest TEXT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `).run();

    // 3. Lineage Table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS Lineage (
        parent_task_id TEXT NOT NULL REFERENCES Tasks(task_id) ON DELETE CASCADE,
        child_task_id TEXT NOT NULL REFERENCES Tasks(task_id) ON DELETE CASCADE,
        PRIMARY KEY (parent_task_id, child_task_id)
      )
    `).run();

    // Check and drop Telemetry if it has the strict Tasks FK constraint to allow attempt IDs
    try {
      const hasFk = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='Telemetry'").get() as any;
      if (hasFk && hasFk.sql.includes('REFERENCES Tasks')) {
        db.prepare('DROP TABLE Telemetry').run();
      }
    } catch (e) {
      // Ignore
    }

    // 4. Telemetry Table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS Telemetry (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        state_from TEXT NOT NULL,
        state_to TEXT NOT NULL,
        duration_ms INTEGER,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // Phase 2 runtime tables
    db.prepare(`
      CREATE TABLE IF NOT EXISTS RunInputs (
        run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
        input_name TEXT NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (run_id, input_name)
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS Artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
        node_id TEXT,
        artifact_type TEXT NOT NULL CHECK(artifact_type IN ('input', 'raw_output', 'reviewed_output', 'synthesis')),
        content_json TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // Migrate NodeInvocations if it exists and lacks AWAITING_HUMAN_REVIEW or Phase 6 columns
    try {
      const nodeInvocationsTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='NodeInvocations'").get() as any;
      if (nodeInvocationsTableSql && (
        !nodeInvocationsTableSql.sql.includes('AWAITING_HUMAN_REVIEW') ||
        !nodeInvocationsTableSql.sql.includes('INTERVENTION_REQUIRED') ||
        !nodeInvocationsTableSql.sql.includes('CANCELLED') ||
        !nodeInvocationsTableSql.sql.includes('required_for_run_success') ||
        !nodeInvocationsTableSql.sql.includes('failure_policy') ||
        !nodeInvocationsTableSql.sql.includes('iteration_no')
      )) {
        db.prepare("ALTER TABLE NodeInvocations RENAME TO NodeInvocations_old").run();
        db.prepare(`
          CREATE TABLE NodeInvocations (
            invocation_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
            node_id TEXT NOT NULL,
            iteration_no INTEGER DEFAULT 1,
            status TEXT NOT NULL CHECK(status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'AWAITING_HUMAN_REVIEW', 'INTERVENTION_REQUIRED')),
            required_for_run_success INTEGER DEFAULT 1 CHECK(required_for_run_success IN (0, 1)),
            failure_policy TEXT DEFAULT 'fail_run' CHECK(failure_policy IN ('fail_run', 'skip_branch', 'continue_with_warning')),
            input_snapshot_json TEXT,
            output_artifact_id TEXT REFERENCES Artifacts(artifact_id) ON DELETE SET NULL,
            error_message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (run_id, node_id)
          )
        `).run();
        const oldCols = db.prepare("PRAGMA table_info(NodeInvocations_old)").all() as any[];
        const hasErrorMessage = oldCols.some(c => c.name === 'error_message');
        const hasOutputArtifactId = oldCols.some(c => c.name === 'output_artifact_id');
        db.prepare(`
          INSERT INTO NodeInvocations (
            invocation_id, run_id, node_id, status, created_at, updated_at
            ${hasErrorMessage ? ', error_message' : ''}
            ${hasOutputArtifactId ? ', output_artifact_id' : ''}
          )
          SELECT 
            invocation_id, run_id, node_id, status, created_at, updated_at
            ${hasErrorMessage ? ', error_message' : ''}
            ${hasOutputArtifactId ? ', output_artifact_id' : ''}
          FROM NodeInvocations_old
        `).run();
        db.prepare("DROP TABLE NodeInvocations_old").run();
      }
    } catch (e) {
      // Ignore
    }

    db.prepare(`
      CREATE TABLE IF NOT EXISTS NodeInvocations (
        invocation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        iteration_no INTEGER DEFAULT 1,
        status TEXT NOT NULL CHECK(status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'AWAITING_HUMAN_REVIEW', 'INTERVENTION_REQUIRED')),
        required_for_run_success INTEGER DEFAULT 1 CHECK(required_for_run_success IN (0, 1)),
        failure_policy TEXT DEFAULT 'fail_run' CHECK(failure_policy IN ('fail_run', 'skip_branch', 'continue_with_warning')),
        input_snapshot_json TEXT,
        output_artifact_id TEXT REFERENCES Artifacts(artifact_id) ON DELETE SET NULL,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (run_id, node_id)
      )
    `).run();

    try {
      const taskAttemptsTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='TaskAttempts'").get() as any;
      if (taskAttemptsTableSql && (!taskAttemptsTableSql.sql.includes('INTERVENTION_REQUIRED') || !taskAttemptsTableSql.sql.includes('CANCELLED'))) {
        db.prepare("ALTER TABLE TaskAttempts RENAME TO TaskAttempts_old").run();
        db.prepare(`
          CREATE TABLE TaskAttempts (
            attempt_id TEXT PRIMARY KEY,
            invocation_id TEXT NOT NULL REFERENCES NodeInvocations(invocation_id) ON DELETE CASCADE,
            attempt_no INTEGER NOT NULL,
            provider_name TEXT NOT NULL,
            prompt_payload TEXT NOT NULL,
            response_text TEXT,
            status TEXT NOT NULL CHECK(status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERVENTION_REQUIRED')),
            error_message TEXT,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP
          )
        `).run();
        db.prepare(`
          INSERT INTO TaskAttempts (
            attempt_id, invocation_id, attempt_no, provider_name, prompt_payload, response_text,
            status, error_message, started_at, completed_at
          )
          SELECT
            attempt_id, invocation_id, attempt_no, provider_name, prompt_payload, response_text,
            status, error_message, started_at, completed_at
          FROM TaskAttempts_old
        `).run();
        db.prepare("DROP TABLE TaskAttempts_old").run();
      }
    } catch (e) {
      // Ignore
    }

    db.prepare(`
      CREATE TABLE IF NOT EXISTS TaskAttempts (
        attempt_id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL REFERENCES NodeInvocations(invocation_id) ON DELETE CASCADE,
        attempt_no INTEGER NOT NULL,
        provider_name TEXT NOT NULL,
        prompt_payload TEXT NOT NULL,
        response_text TEXT,
        thread_url TEXT,
        context_mode TEXT,
        context_fidelity TEXT,
        adapter_state_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERVENTION_REQUIRED')),
        error_message TEXT,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `).run();

    const taskAttemptColumns = db.prepare("PRAGMA table_info(TaskAttempts)").all() as any[];
    const taskAttemptColumnNames = new Set(taskAttemptColumns.map(col => col.name));
    for (const [columnName, columnType] of [
      ['thread_url', 'TEXT'],
      ['context_mode', 'TEXT'],
      ['context_fidelity', 'TEXT'],
      ['adapter_state_json', 'TEXT']
    ] as const) {
      if (!taskAttemptColumnNames.has(columnName)) {
        db.prepare(`ALTER TABLE TaskAttempts ADD COLUMN ${columnName} ${columnType}`).run();
      }
    }

    db.prepare(`
      CREATE TABLE IF NOT EXISTS ArtifactLineage (
        parent_artifact_id TEXT NOT NULL REFERENCES Artifacts(artifact_id) ON DELETE CASCADE,
        child_invocation_id TEXT NOT NULL REFERENCES NodeInvocations(invocation_id) ON DELETE CASCADE,
        PRIMARY KEY (parent_artifact_id, child_invocation_id)
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS HumanReviewEvents (
        review_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL REFERENCES NodeInvocations(invocation_id) ON DELETE CASCADE,
        raw_artifact_id TEXT NOT NULL REFERENCES Artifacts(artifact_id) ON DELETE CASCADE,
        reviewed_artifact_id TEXT REFERENCES Artifacts(artifact_id) ON DELETE SET NULL,
        decision TEXT NOT NULL CHECK(decision IN ('APPROVED', 'EDITED', 'REJECTED')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS SummaryEvaluationMetrics (
        metric_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES Runs(run_id) ON DELETE CASCADE,
        round_no INTEGER NOT NULL DEFAULT 1,
        summary_task_id TEXT,
        defender_task_id TEXT,
        summary_artifact_id TEXT REFERENCES Artifacts(artifact_id) ON DELETE SET NULL,
        defender_artifact_id TEXT REFERENCES Artifacts(artifact_id) ON DELETE SET NULL,
        defender_label TEXT NOT NULL,
        coverage_score REAL NOT NULL,
        omission_score REAL NOT NULL,
        distortion_score REAL NOT NULL,
        contradiction_score REAL NOT NULL,
        verdict_accuracy REAL NOT NULL,
        key_claims_total INTEGER NOT NULL,
        key_claims_preserved INTEGER NOT NULL,
        key_claims_omitted INTEGER NOT NULL,
        key_claims_distorted INTEGER NOT NULL,
        key_claims_contradicted INTEGER NOT NULL,
        rouge1_f1 REAL NOT NULL,
        rouge2_f1 REAL NOT NULL,
        rouge_l_f1 REAL NOT NULL,
        evaluator_provider TEXT,
        evaluator_task_id TEXT,
        evaluator_response_json TEXT,
        evaluator_rationale TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // 5. Indexes
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON Tasks(run_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_lineage_parent ON Lineage(parent_task_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_lineage_child ON Lineage(child_task_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_workflow_drafts_updated_at ON WorkflowDrafts(updated_at)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_node_invocations_run_id ON NodeInvocations(run_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_task_attempts_invocation_id ON TaskAttempts(invocation_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON Artifacts(run_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_summary_eval_run_id ON SummaryEvaluationMetrics(run_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mcp_tool_metrics_tool_status ON McpToolCallMetrics(tool_name, status)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mcp_tool_metrics_run_id ON McpToolCallMetrics(run_id)`).run();
  })();

  repairLegacyTasksRunForeignKey(db);
  repairAllLegacyForeignKeys(db);
}

export class DBService {
  private static defaultGraphJson(): string {
    return JSON.stringify({
      nodes: [
        {
          id: 'input_topic',
          type: 'input',
          label: 'Topic Input',
          x: 80,
          y: 160,
          config: { variable: 'topic' }
        },
        {
          id: 'llm_summary',
          type: 'llm',
          label: 'LLM Summary',
          x: 360,
          y: 160,
          config: {
            provider: 'mock',
            prompt: 'Summarize {{topic}} in three concise bullets.'
          }
        }
      ],
      edges: [
        {
          id: 'edge_input_summary',
          source: 'input_topic',
          target: 'llm_summary',
          type: 'execution'
        }
      ],
      viewport: { x: 0, y: 0, zoom: 1 }
    }, null, 2);
  }

  private static touchWorkflow(workflowId: string): void {
    getDB().prepare('UPDATE WorkflowTemplates SET updated_at = CURRENT_TIMESTAMP WHERE workflow_id = ?').run(workflowId);
  }

  public static createWorkflow(params: { name: string; description?: string | null; graphJson?: string }): any {
    const workflowId = `wf_${crypto.randomUUID()}`;
    const graphJson = params.graphJson || DBService.defaultGraphJson();

    getDB().transaction(() => {
      getDB().prepare(`
        INSERT INTO WorkflowTemplates (workflow_id, name, description)
        VALUES (@workflowId, @name, @description)
      `).run({
        workflowId,
        name: params.name.trim(),
        description: params.description || null
      });

      getDB().prepare(`
        INSERT INTO WorkflowDrafts (workflow_id, graph_json)
        VALUES (?, ?)
      `).run(workflowId, graphJson);

      getDB().prepare(`
        INSERT INTO WorkflowInputDefinitions (
          input_def_id,
          workflow_id,
          name,
          type,
          required,
          description
        )
        VALUES (?, ?, 'topic', 'string', 1, 'Primary workflow topic')
      `).run(`input_${crypto.randomUUID()}`, workflowId);
    })();

    return DBService.getWorkflow(workflowId);
  }

  public static listWorkflows(): any[] {
    return getDB().prepare(`
      SELECT
        wt.workflow_id,
        wt.name,
        wt.description,
        wt.created_at,
        wt.updated_at,
        COUNT(DISTINCT wid.input_def_id) AS input_count,
        COUNT(DISTINCT cwv.workflow_version_id) AS version_count
      FROM WorkflowTemplates wt
      LEFT JOIN WorkflowInputDefinitions wid ON wid.workflow_id = wt.workflow_id
      LEFT JOIN CompiledWorkflowVersions cwv ON cwv.workflow_id = wt.workflow_id
      GROUP BY wt.workflow_id
      ORDER BY wt.updated_at DESC
    `).all();
  }

  public static getWorkflow(workflowId: string): any | null {
    return getDB().prepare('SELECT * FROM WorkflowTemplates WHERE workflow_id = ?').get(workflowId) || null;
  }

  public static updateWorkflow(params: { workflowId: string; name?: string; description?: string | null }): any | null {
    const existing = DBService.getWorkflow(params.workflowId);
    if (!existing) return null;

    getDB().prepare(`
      UPDATE WorkflowTemplates
      SET name = @name,
          description = @description,
          updated_at = CURRENT_TIMESTAMP
      WHERE workflow_id = @workflowId
    `).run({
      workflowId: params.workflowId,
      name: params.name?.trim() || existing.name,
      description: params.description === undefined ? existing.description : params.description
    });

    return DBService.getWorkflow(params.workflowId);
  }

  public static getDraft(workflowId: string): any | null {
    return getDB().prepare(`
      SELECT workflow_id, graph_json, updated_at
      FROM WorkflowDrafts
      WHERE workflow_id = ?
    `).get(workflowId) || null;
  }

  public static saveDraft(workflowId: string, graphJson: string): any | null {
    if (!DBService.getWorkflow(workflowId)) return null;

    getDB().transaction(() => {
      getDB().prepare(`
        INSERT INTO WorkflowDrafts (workflow_id, graph_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(workflow_id) DO UPDATE SET
          graph_json = excluded.graph_json,
          updated_at = CURRENT_TIMESTAMP
      `).run(workflowId, graphJson);
      DBService.touchWorkflow(workflowId);
    })();

    return DBService.getDraft(workflowId);
  }

  public static listInputs(workflowId: string): any[] {
    return getDB().prepare(`
      SELECT input_def_id, workflow_id, name, type, required, default_value_json, description
      FROM WorkflowInputDefinitions
      WHERE workflow_id = ?
      ORDER BY name ASC
    `).all(workflowId);
  }

  public static replaceInputs(workflowId: string, inputs: Array<{
    name: string;
    type: 'string' | 'number' | 'file';
    required?: boolean | number;
    default_value_json?: string | null;
    description?: string | null;
  }>): any[] | null {
    if (!DBService.getWorkflow(workflowId)) return null;

    getDB().transaction(() => {
      getDB().prepare('DELETE FROM WorkflowInputDefinitions WHERE workflow_id = ?').run(workflowId);

      const insert = getDB().prepare(`
        INSERT INTO WorkflowInputDefinitions (
          input_def_id,
          workflow_id,
          name,
          type,
          required,
          default_value_json,
          description
        )
        VALUES (@inputDefId, @workflowId, @name, @type, @required, @defaultValueJson, @description)
      `);

      for (const input of inputs) {
        const name = input.name.trim();
        if (!name) continue;

        insert.run({
          inputDefId: `input_${crypto.randomUUID()}`,
          workflowId,
          name,
          type: input.type,
          required: input.required === false || input.required === 0 ? 0 : 1,
          defaultValueJson: input.default_value_json || null,
          description: input.description || null
        });
      }

      DBService.touchWorkflow(workflowId);
    })();

    return DBService.listInputs(workflowId);
  }

  public static createCompiledVersion(params: {
    workflowId: string;
    sourceGraphJson: string;
    compiledPlanJson: string;
    validationReportJson: string;
    compilerVersion: string;
  }): any {
    const nextVersion = (getDB().prepare(`
      SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no
      FROM CompiledWorkflowVersions
      WHERE workflow_id = ?
    `).get(params.workflowId) as any).version_no;

    const workflowVersionId = `wfv_${crypto.randomUUID()}`;
    getDB().prepare(`
      INSERT INTO CompiledWorkflowVersions (
        workflow_version_id,
        workflow_id,
        version_no,
        source_graph_json,
        compiled_plan_json,
        validation_report_json,
        compiler_version
      )
      VALUES (@workflowVersionId, @workflowId, @versionNo, @sourceGraphJson, @compiledPlanJson, @validationReportJson, @compilerVersion)
    `).run({
      workflowVersionId,
      workflowId: params.workflowId,
      versionNo: nextVersion,
      sourceGraphJson: params.sourceGraphJson,
      compiledPlanJson: params.compiledPlanJson,
      validationReportJson: params.validationReportJson,
      compilerVersion: params.compilerVersion
    });

    DBService.touchWorkflow(params.workflowId);
    return getDB().prepare('SELECT * FROM CompiledWorkflowVersions WHERE workflow_version_id = ?').get(workflowVersionId);
  }

  public static listCompiledVersions(workflowId: string): any[] {
    return getDB().prepare(`
      SELECT workflow_version_id, workflow_id, version_no, validation_report_json, compiler_version, compiled_at
      FROM CompiledWorkflowVersions
      WHERE workflow_id = ?
      ORDER BY version_no DESC
    `).all(workflowId);
  }

  /**
   * Creates a new orchestration run
   */
  public static createRun(runId: string, topic: string): void {
    const stmt = getDB().prepare('INSERT OR IGNORE INTO Runs (run_id, topic) VALUES (?, ?)');
    stmt.run(runId, topic);
  }

  /**
   * Updates a run's status
   */
  public static getRunStatus(runId: string): RunStatus | null {
    const row = getDB().prepare('SELECT status FROM Runs WHERE run_id = ?').get(runId) as { status?: RunStatus } | undefined;
    return row?.status ?? null;
  }

  public static updateRunStatus(runId: string, status: RunStatus): void {
    const stmt = getDB().prepare('UPDATE Runs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE run_id = ?');
    stmt.run(status, runId);
  }

  public static updateRunStatusIfNotTerminal(runId: string, status: RunStatus): boolean {
    const stmt = getDB().prepare(`
      UPDATE Runs
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ?
        AND status NOT IN ('COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED', 'INTERVENTION_REQUIRED')
    `);
    return stmt.run(status, runId).changes === 1;
  }

  public static createMcpToolCallMetric(params: {
    toolCallId: string;
    toolName: string;
    requestedProviderCount?: number;
    contextDigest?: string | null;
  }): void {
    getDB().prepare(`
      INSERT INTO McpToolCallMetrics (
        tool_call_id,
        tool_name,
        status,
        requested_provider_count,
        context_digest
      ) VALUES (
        @toolCallId,
        @toolName,
        'RECEIVED',
        @requestedProviderCount,
        @contextDigest
      )
    `).run({
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      requestedProviderCount: params.requestedProviderCount ?? 0,
      contextDigest: params.contextDigest ?? null
    });
  }

  public static completeMcpToolCallMetric(params: {
    toolCallId: string;
    runId?: string | null;
    status: 'COMPLETED' | 'PARTIAL_SUCCESS';
    requestedProviderCount?: number;
    successfulProviderCount?: number;
    failedProviderCount?: number;
    durationMs?: number | null;
    contextDigest?: string | null;
  }): void {
    getDB().prepare(`
      UPDATE McpToolCallMetrics
      SET run_id = @runId,
          status = @status,
          requested_provider_count = @requestedProviderCount,
          successful_provider_count = @successfulProviderCount,
          failed_provider_count = @failedProviderCount,
          duration_ms = @durationMs,
          context_digest = @contextDigest,
          error_message = NULL,
          completed_at = CURRENT_TIMESTAMP
      WHERE tool_call_id = @toolCallId
    `).run({
      toolCallId: params.toolCallId,
      runId: params.runId ?? null,
      status: params.status,
      requestedProviderCount: params.requestedProviderCount ?? 0,
      successfulProviderCount: params.successfulProviderCount ?? 0,
      failedProviderCount: params.failedProviderCount ?? 0,
      durationMs: params.durationMs ?? null,
      contextDigest: params.contextDigest ?? null
    });
  }

  public static failMcpToolCallMetric(params: {
    toolCallId: string;
    runId?: string | null;
    status?: 'VALIDATION_FAILED' | 'FAILED' | 'CANCELLED' | 'INTERVENTION_REQUIRED';
    requestedProviderCount?: number;
    successfulProviderCount?: number;
    failedProviderCount?: number;
    durationMs?: number | null;
    contextDigest?: string | null;
    errorMessage?: string | null;
  }): void {
    getDB().prepare(`
      UPDATE McpToolCallMetrics
      SET run_id = @runId,
          status = @status,
          requested_provider_count = @requestedProviderCount,
          successful_provider_count = @successfulProviderCount,
          failed_provider_count = @failedProviderCount,
          duration_ms = @durationMs,
          context_digest = @contextDigest,
          error_message = @errorMessage,
          completed_at = CURRENT_TIMESTAMP
      WHERE tool_call_id = @toolCallId
    `).run({
      toolCallId: params.toolCallId,
      runId: params.runId ?? null,
      status: params.status ?? 'FAILED',
      requestedProviderCount: params.requestedProviderCount ?? 0,
      successfulProviderCount: params.successfulProviderCount ?? 0,
      failedProviderCount: params.failedProviderCount ?? 0,
      durationMs: params.durationMs ?? null,
      contextDigest: params.contextDigest ?? null,
      errorMessage: params.errorMessage ?? null
    });
  }

  public static getMcpToolCallMetrics(params: {
    toolCallId?: string;
    toolName?: string;
    runId?: string;
    status?: string;
  } = {}): any[] {
    const clauses: string[] = [];
    const values: any = {};
    if (params.toolCallId) {
      clauses.push('tool_call_id = @toolCallId');
      values.toolCallId = params.toolCallId;
    }
    if (params.toolName) {
      clauses.push('tool_name = @toolName');
      values.toolName = params.toolName;
    }
    if (params.runId) {
      clauses.push('run_id = @runId');
      values.runId = params.runId;
    }
    if (params.status) {
      clauses.push('status = @status');
      values.status = params.status;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return getDB().prepare(`
      SELECT *
      FROM McpToolCallMetrics
      ${where}
      ORDER BY created_at ASC, tool_call_id ASC
    `).all(values);
  }

  /**
   * Inserts a task
   */
  public static createTask(params: {
    taskId: string;
    runId: string;
    providerName: string;
    promptPayload: string;
    status: string;
    attemptNo?: number;
  }): void {
    const stmt = getDB().prepare(`
      INSERT INTO Tasks (task_id, run_id, provider_name, prompt_payload, status, attempt_no)
      VALUES (@taskId, @runId, @providerName, @promptPayload, @status, @attemptNo)
    `);
    stmt.run({ ...params, attemptNo: params.attemptNo ?? 1 });
  }

  /**
   * Updates a task with its final response details
   */
  public static updateTaskResponse(params: {
    taskId: string;
    responseText: string;
    extractionMethod: 'clean' | 'timeout_forced' | 'manual' | 'api';
    status: string;
  }): void {
    const stmt = getDB().prepare(`
      UPDATE Tasks 
      SET response_text = @responseText, extraction_method = @extractionMethod, status = @status
      WHERE task_id = @taskId
        AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'INTERVENTION_REQUIRED')
    `);
    stmt.run(params);
  }

  /**
   * Updates a task status
   */
  public static updateTaskStatus(taskId: string, status: string): void {
    const stmt = getDB().prepare(`
      UPDATE Tasks
      SET status = ?
      WHERE task_id = ?
        AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'INTERVENTION_REQUIRED')
    `);
    stmt.run(status, taskId);
  }

  public static markTaskSubmissionConfirmed(taskId: string): void {
    getDB().prepare(`
      UPDATE Tasks
      SET submission_confirmed = 1
      WHERE task_id = ?
        AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'INTERVENTION_REQUIRED')
    `).run(taskId);
  }

  public static failTaskWithClassification(taskId: string, status: 'FAILED' | 'CANCELLED' | 'INTERVENTION_REQUIRED', failureCode: FailureCode, submissionConfirmed: boolean): void {
    getDB().prepare(`
      UPDATE Tasks
      SET status = ?,
          failure_code = ?,
          submission_confirmed = CASE WHEN submission_confirmed = 1 OR ? = 1 THEN 1 ELSE 0 END
      WHERE task_id = ?
        AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'INTERVENTION_REQUIRED')
    `).run(status, failureCode, submissionConfirmed ? 1 : 0, taskId);
  }

  /**
   * Connects a parent and child task in the Lineage tree
   */
  public static addLineage(parentTaskId: string, childTaskId: string): void {
    const stmt = getDB().prepare('INSERT OR IGNORE INTO Lineage (parent_task_id, child_task_id) VALUES (?, ?)');
    stmt.run(parentTaskId, childTaskId);
  }

  /**
   * Records a telemetry state-transition event
   */
  public static addTelemetry(params: {
    taskId: string;
    stateFrom: string;
    stateTo: string;
    durationMs: number | null;
  }): void {
    const stmt = getDB().prepare(`
      INSERT INTO Telemetry (task_id, state_from, state_to, duration_ms)
      VALUES (@taskId, @stateFrom, @stateTo, @durationMs)
    `);
    stmt.run(params);
  }

  /**
   * Retrieves high-resolution lineage pathways using Recursive Semantic Provenance
   */
  public static getProvenancePath(childTaskId: string): any[] {
    const stmt = getDB().prepare(`
      WITH RECURSIVE ProvenancePath AS (
        SELECT parent_task_id, child_task_id, parent_task_id AS step_id
        FROM Lineage
        WHERE child_task_id = ?
        
        UNION ALL
        
        SELECT l.parent_task_id, l.child_task_id, l.parent_task_id AS step_id
        FROM Lineage l
        INNER JOIN ProvenancePath pp ON l.child_task_id = pp.parent_task_id
      )
      SELECT pp.parent_task_id, pp.child_task_id, t.prompt_payload, t.response_text, t.provider_name
      FROM ProvenancePath pp
      JOIN Tasks t ON pp.parent_task_id = t.task_id
    `);
    return stmt.all(childTaskId);
  }

  /**
   * Creates a new workflow run and pre-creates input artifacts
   */
  public static createWorkflowRun(params: {
    runId: string;
    workflowVersionId: string;
    topic: string;
    inputs: Record<string, any>;
  }): void {
    getDB().transaction(() => {
      getDB().prepare(`
        INSERT INTO Runs (run_id, topic, status, workflow_version_id)
        VALUES (@runId, @topic, 'IN_PROGRESS', @workflowVersionId)
      `).run(params);

      for (const [name, val] of Object.entries(params.inputs)) {
        const valJson = JSON.stringify({ value: val });
        getDB().prepare(`
          INSERT INTO RunInputs (run_id, input_name, value_json)
          VALUES (?, ?, ?)
        `).run(params.runId, name, valJson);

        getDB().prepare(`
          INSERT INTO Artifacts (artifact_id, run_id, node_id, artifact_type, content_json)
          VALUES (?, ?, NULL, 'input', ?)
        `).run(`art_in_${params.runId}_${name}`, params.runId, valJson);
      }
    })();
  }

  /**
   * Pre-materializes node invocations for a run
   */
  public static preMaterializeNodeInvocations(runId: string, nodes: any[]): void {
    getDB().transaction(() => {
      const stmt = getDB().prepare(`
        INSERT OR IGNORE INTO NodeInvocations (
          invocation_id, run_id, node_id, status, required_for_run_success, failure_policy
        ) VALUES (?, ?, ?, 'PENDING', ?, ?)
      `);
      for (const node of nodes) {
        if (typeof node === 'string') {
          stmt.run(`inv_${runId}_${node}`, runId, node, 1, 'fail_run');
        } else {
          const req = node.config?.required_for_run_success === false || node.config?.required_for_run_success === 0 ? 0 : 1;
          const pol = node.config?.failure_policy || 'fail_run';
          stmt.run(`inv_${runId}_${node.node_id}`, runId, node.node_id, req, pol);
        }
      }
    })();
  }

  /**
   * Atomically transitions a node invocation to RUNNING if it is currently PENDING
   */
  public static atomicStartInvocation(invocationId: string): boolean {
    const result = getDB().prepare(`
      UPDATE NodeInvocations
      SET status = 'RUNNING', updated_at = CURRENT_TIMESTAMP
      WHERE invocation_id = ? AND status = 'PENDING'
    `).run(invocationId);
    return result.changes === 1;
  }

  /**
   * Creates a task attempt for a node invocation
   */
  public static createTaskAttempt(params: {
    attemptId: string;
    invocationId: string;
    attemptNo: number;
    providerName: string;
    promptPayload: string;
    status: string;
  }): void {
    getDB().prepare(`
      INSERT INTO TaskAttempts (attempt_id, invocation_id, attempt_no, provider_name, prompt_payload, status)
      VALUES (@attemptId, @invocationId, @attemptNo, @providerName, @promptPayload, @status)
    `).run(params);
  }

  /**
   * Completes a task attempt
   */
  public static completeTaskAttempt(attemptId: string, responseText: string, metadata: {
    threadUrl?: string | null;
    contextMode?: string | null;
    contextFidelity?: string | null;
    adapterStateJson?: string | null;
  } = {}): void {
    getDB().prepare(`
      UPDATE TaskAttempts
      SET response_text = ?,
          thread_url = ?,
          context_mode = ?,
          context_fidelity = ?,
          adapter_state_json = ?,
          status = 'COMPLETED',
          completed_at = CURRENT_TIMESTAMP
      WHERE attempt_id = ?
    `).run(
      responseText,
      metadata.threadUrl ?? null,
      metadata.contextMode ?? null,
      metadata.contextFidelity ?? null,
      metadata.adapterStateJson ?? null,
      attemptId
    );
  }

  /**
   * Fails a task attempt
   */
  public static failTaskAttempt(attemptId: string, errorMessage: string): void {
    getDB().prepare(`
      UPDATE TaskAttempts
      SET error_message = ?, status = 'FAILED', completed_at = CURRENT_TIMESTAMP
      WHERE attempt_id = ?
    `).run(errorMessage, attemptId);
  }

  public static markTaskAttemptInterventionRequired(attemptId: string, errorMessage: string): void {
    getDB().prepare(`
      UPDATE TaskAttempts
      SET error_message = ?, status = 'INTERVENTION_REQUIRED', completed_at = CURRENT_TIMESTAMP
      WHERE attempt_id = ?
    `).run(errorMessage, attemptId);
  }

  /**
   * Completes a node invocation with its output artifact
   */
  public static completeNodeInvocation(invocationId: string, outputArtifactId: string): void {
    getDB().prepare(`
      UPDATE NodeInvocations
      SET status = 'COMPLETED', output_artifact_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE invocation_id = ?
    `).run(outputArtifactId, invocationId);
  }

  /**
   * Fails a node invocation
   */
  public static failNodeInvocation(invocationId: string, errorMessage: string): void {
    getDB().prepare(`
      UPDATE NodeInvocations
      SET status = 'FAILED', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE invocation_id = ?
    `).run(errorMessage, invocationId);
  }

  public static setInvocationInterventionRequired(invocationId: string, errorMessage: string): void {
    getDB().prepare(`
      UPDATE NodeInvocations
      SET status = 'INTERVENTION_REQUIRED', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE invocation_id = ?
    `).run(errorMessage, invocationId);
  }

  /**
   * Creates a new artifact
   */
  public static createArtifact(params: {
    artifactId: string;
    runId: string;
    nodeId: string | null;
    artifactType: string;
    contentJson: string;
  }): void {
    getDB().prepare(`
      INSERT INTO Artifacts (artifact_id, run_id, node_id, artifact_type, content_json)
      VALUES (@artifactId, @runId, @nodeId, @artifactType, @contentJson)
    `).run(params);
  }

  /**
   * Connects a parent artifact to a child invocation in lineage
   */
  public static addArtifactLineage(parentArtifactId: string, childInvocationId: string): void {
    getDB().prepare(`
      INSERT OR IGNORE INTO ArtifactLineage (parent_artifact_id, child_invocation_id)
      VALUES (?, ?)
    `).run(parentArtifactId, childInvocationId);
  }

  /**
   * Retrieves all artifacts of a run
   */
  public static getRunArtifacts(runId: string): any[] {
    return getDB().prepare(`
      SELECT * FROM Artifacts WHERE run_id = ? ORDER BY created_at ASC
    `).all(runId);
  }

  /**
   * Retrieves all node invocations of a run
   */
  public static getNodeInvocations(runId: string): any[] {
    return getDB().prepare(`
      SELECT * FROM NodeInvocations WHERE run_id = ?
    `).all(runId);
  }

  /**
   * Retrieves the artifact lineage of a run
   */
  public static getArtifactLineage(runId: string): any[] {
    return getDB().prepare(`
      SELECT al.* 
      FROM ArtifactLineage al
      JOIN NodeInvocations ni ON al.child_invocation_id = ni.invocation_id
      WHERE ni.run_id = ?
    `).all(runId);
  }

  public static createSummaryEvaluationMetric(params: {
    metricId: string;
    runId: string;
    roundNo: number;
    summaryTaskId?: string | null;
    defenderTaskId?: string | null;
    summaryArtifactId?: string | null;
    defenderArtifactId?: string | null;
    defenderLabel: string;
    coverageScore: number;
    omissionScore: number;
    distortionScore: number;
    contradictionScore: number;
    verdictAccuracy: number;
    keyClaimsTotal: number;
    keyClaimsPreserved: number;
    keyClaimsOmitted: number;
    keyClaimsDistorted: number;
    keyClaimsContradicted: number;
    rouge1F1: number;
    rouge2F1: number;
    rougeLF1: number;
    evaluatorProvider?: string | null;
    evaluatorTaskId?: string | null;
    evaluatorResponseJson?: string | null;
    evaluatorRationale?: string | null;
  }): void {
    getDB().prepare(`
      INSERT INTO SummaryEvaluationMetrics (
        metric_id,
        run_id,
        round_no,
        summary_task_id,
        defender_task_id,
        summary_artifact_id,
        defender_artifact_id,
        defender_label,
        coverage_score,
        omission_score,
        distortion_score,
        contradiction_score,
        verdict_accuracy,
        key_claims_total,
        key_claims_preserved,
        key_claims_omitted,
        key_claims_distorted,
        key_claims_contradicted,
        rouge1_f1,
        rouge2_f1,
        rouge_l_f1,
        evaluator_provider,
        evaluator_task_id,
        evaluator_response_json,
        evaluator_rationale
      ) VALUES (
        @metricId,
        @runId,
        @roundNo,
        @summaryTaskId,
        @defenderTaskId,
        @summaryArtifactId,
        @defenderArtifactId,
        @defenderLabel,
        @coverageScore,
        @omissionScore,
        @distortionScore,
        @contradictionScore,
        @verdictAccuracy,
        @keyClaimsTotal,
        @keyClaimsPreserved,
        @keyClaimsOmitted,
        @keyClaimsDistorted,
        @keyClaimsContradicted,
        @rouge1F1,
        @rouge2F1,
        @rougeLF1,
        @evaluatorProvider,
        @evaluatorTaskId,
        @evaluatorResponseJson,
        @evaluatorRationale
      )
    `).run({
      ...params,
      summaryTaskId: params.summaryTaskId ?? null,
      defenderTaskId: params.defenderTaskId ?? null,
      summaryArtifactId: params.summaryArtifactId ?? null,
      defenderArtifactId: params.defenderArtifactId ?? null,
      evaluatorProvider: params.evaluatorProvider ?? null,
      evaluatorTaskId: params.evaluatorTaskId ?? null,
      evaluatorResponseJson: params.evaluatorResponseJson ?? null,
      evaluatorRationale: params.evaluatorRationale ?? null
    });
  }

  public static getSummaryEvaluationMetrics(runId: string): any[] {
    return getDB().prepare(`
      SELECT *
      FROM SummaryEvaluationMetrics
      WHERE run_id = ?
      ORDER BY round_no ASC, created_at ASC, defender_label ASC
    `).all(runId);
  }

  public static getSummaryEvaluationAggregate(runId: string): any {
    const rows = this.getSummaryEvaluationMetrics(runId);
    if (rows.length === 0) {
      return {
        defenders_evaluated: 0,
        average_coverage: 0,
        average_omission: 0,
        average_distortion: 0,
        average_contradiction: 0,
        verdict_preservation_rate: 0,
        lowest_covered_defender: null,
        rouge1_f1_mean: 0,
        rouge2_f1_mean: 0,
        rouge_l_f1_mean: 0
      };
    }

    const mean = (key: string) => rows.reduce((sum, row) => sum + Number(row[key] || 0), 0) / rows.length;
    const lowest = rows.reduce((current, row) => {
      if (!current || Number(row.coverage_score) < Number(current.coverage_score)) return row;
      return current;
    }, null as any);

    return {
      defenders_evaluated: rows.length,
      average_coverage: mean('coverage_score'),
      average_omission: mean('omission_score'),
      average_distortion: mean('distortion_score'),
      average_contradiction: mean('contradiction_score'),
      verdict_preservation_rate: mean('verdict_accuracy'),
      lowest_covered_defender: lowest ? lowest.defender_label : null,
      rouge1_f1_mean: mean('rouge1_f1'),
      rouge2_f1_mean: mean('rouge2_f1'),
      rouge_l_f1_mean: mean('rouge_l_f1')
    };
  }

  /**
   * Transitions a node invocation status to AWAITING_HUMAN_REVIEW
   */
  public static setInvocationAwaitingReview(invocationId: string): void {
    const db = getDB();
    db.transaction(() => {
      db.prepare(`
        UPDATE NodeInvocations
        SET status = 'AWAITING_HUMAN_REVIEW', updated_at = CURRENT_TIMESTAMP
        WHERE invocation_id = ?
      `).run(invocationId);

      const inv = db.prepare(`SELECT run_id FROM NodeInvocations WHERE invocation_id = ?`).get(invocationId) as { run_id: string } | undefined;
      if (inv) {
        db.prepare(`
          UPDATE Runs
          SET status = 'AWAITING_HUMAN_REVIEW', updated_at = CURRENT_TIMESTAMP
          WHERE run_id = ?
        `).run(inv.run_id);
      }
    })();
  }

  /**
   * Records a human review event in the database
   */
  public static recordHumanReview(params: {
    reviewId: string;
    runId: string;
    nodeId: string;
    invocationId: string;
    rawArtifactId: string;
    reviewedArtifactId: string | null;
    decision: 'APPROVED' | 'EDITED' | 'REJECTED';
  }): void {
    getDB().prepare(`
      INSERT INTO HumanReviewEvents (
        review_id, run_id, node_id, invocation_id, raw_artifact_id, reviewed_artifact_id, decision
      ) VALUES (
        @reviewId, @runId, @nodeId, @invocationId, @rawArtifactId, @reviewedArtifactId, @decision
      )
    `).run(params);
  }

  public static runExists(runId: string): boolean {
    const row = getDB().prepare('SELECT 1 FROM Runs WHERE run_id = ?').get(runId);
    return !!row;
  }

  public static getRunInputs(runId: string): Record<string, any> {
    const rows = getDB().prepare('SELECT input_name, value_json FROM RunInputs WHERE run_id = ?').all(runId) as any[];
    const inputs: Record<string, any> = {};
    for (const row of rows) {
      try {
        inputs[row.input_name] = JSON.parse(row.value_json).value;
      } catch {
        inputs[row.input_name] = row.value_json;
      }
    }
    return inputs;
  }

  public static getRunCompiledPlan(runId: string): any | null {
    const row = getDB().prepare(`
      SELECT cwv.compiled_plan_json, r.workflow_version_id
      FROM Runs r
      JOIN CompiledWorkflowVersions cwv ON r.workflow_version_id = cwv.workflow_version_id
      WHERE r.run_id = ?
    `).get(runId) as any;
    if (!row) return null;
    try {
      const plan = JSON.parse(row.compiled_plan_json);
      plan.workflow_version_id = row.workflow_version_id;
      return plan;
    } catch {
      return null;
    }
  }

  public static resetNodeAndDescendants(runId: string, nodeId: string): void {
    const plan = DBService.getRunCompiledPlan(runId);
    if (!plan) return;

    const outgoing = new Map<string, string[]>();
    for (const node of plan.nodes) {
      for (const dep of (node.dependencies || [])) {
        if (!outgoing.has(dep)) outgoing.set(dep, []);
        outgoing.get(dep)!.push(node.node_id);
      }
    }

    const descendants = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const children = outgoing.get(curr) || [];
      for (const child of children) {
        if (!descendants.has(child)) {
          descendants.add(child);
          queue.push(child);
        }
      }
    }

    const db = getDB();
    db.transaction(() => {
      db.prepare(`
        UPDATE NodeInvocations
        SET status = 'PENDING', error_message = NULL, output_artifact_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND node_id = ?
      `).run(runId, nodeId);

      const stmt = db.prepare(`
        UPDATE NodeInvocations
        SET status = 'PENDING', error_message = NULL, output_artifact_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND node_id = ?
      `);
      for (const desc of descendants) {
        stmt.run(runId, desc);
      }

      const allNodes = [nodeId, ...descendants];
      const placeholders = allNodes.map(() => '?').join(',');
      db.prepare(`
        DELETE FROM Artifacts
        WHERE run_id = ? AND node_id IN (${placeholders})
      `).run(runId, ...allNodes);
    })();
  }

  public static skipNodeAndDescendants(runId: string, nodeId: string): void {
    const plan = DBService.getRunCompiledPlan(runId);
    if (!plan) return;

    const outgoing = new Map<string, string[]>();
    for (const node of plan.nodes) {
      for (const dep of (node.dependencies || [])) {
        if (!outgoing.has(dep)) outgoing.set(dep, []);
        outgoing.get(dep)!.push(node.node_id);
      }
    }

    const descendants = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const children = outgoing.get(curr) || [];
      for (const child of children) {
        if (!descendants.has(child)) {
          descendants.add(child);
          queue.push(child);
        }
      }
    }

    const db = getDB();
    db.transaction(() => {
      db.prepare(`
        UPDATE NodeInvocations
        SET status = 'SKIPPED', error_message = NULL, output_artifact_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND node_id = ?
      `).run(runId, nodeId);

      const stmt = db.prepare(`
        UPDATE NodeInvocations
        SET status = 'SKIPPED', error_message = NULL, output_artifact_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND node_id = ?
      `);
      for (const desc of descendants) {
        stmt.run(runId, desc);
      }

      const allNodes = [nodeId, ...descendants];
      const placeholders = allNodes.map(() => '?').join(',');
      db.prepare(`
        DELETE FROM Artifacts
        WHERE run_id = ? AND node_id IN (${placeholders})
      `).run(runId, ...allNodes);
    })();
  }

  public static skipNodeInvocation(invocationId: string): void {
    getDB().prepare(`
      UPDATE NodeInvocations
      SET status = 'SKIPPED', updated_at = CURRENT_TIMESTAMP
      WHERE invocation_id = ?
    `).run(invocationId);
  }

  public static getRecentRuns(limit: number): any[] {
    return getDB().prepare('SELECT * FROM Runs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  public static getRecentTelemetry(limit: number): any[] {
    return getDB().prepare(`
      SELECT t.event_id, t.task_id, t.state_from, t.state_to, t.duration_ms, t.timestamp
      FROM Telemetry t
      ORDER BY t.event_id DESC
      LIMIT ?
    `).all(limit);
  }
}
