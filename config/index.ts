import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const defaultWorkspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dotenvRoot = process.env.COUNCIL_WORKSPACE_ROOT
  ? path.resolve(process.env.COUNCIL_WORKSPACE_ROOT)
  : defaultWorkspaceRoot;

if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.resolve(dotenvRoot, '.env') });
}

export function resolveWorkspaceRoot(value: string | undefined = process.env.COUNCIL_WORKSPACE_ROOT): string {
  return value ? path.resolve(value) : defaultWorkspaceRoot;
}

const rootDir = resolveWorkspaceRoot();

export const config = {
  databasePath: process.env.DATABASE_PATH ? path.resolve(rootDir, process.env.DATABASE_PATH) : path.resolve(rootDir, './orchestrator.db'),
  enableCouncilEvaluation: process.env.ENABLE_COUNCIL_EVALUATION !== 'false',
  requireStructuredReviewContext: process.env.REQUIRE_STRUCTURED_REVIEW_CONTEXT === 'true',
  rootDir,
};
