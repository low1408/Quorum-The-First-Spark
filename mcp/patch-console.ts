import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const workspaceRoot = process.env.COUNCIL_WORKSPACE_ROOT
  ? path.resolve(process.env.COUNCIL_WORKSPACE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const logPath = path.resolve(workspaceRoot, 'quorum-mcp.log');

function writeLog(level: string, ...args: any[]) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const timestamp = new Date().toISOString();
    const message = args
      .map(arg => {
        if (arg instanceof Error) {
          return arg.stack || arg.message;
        }
        return typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg);
      })
      .join(' ');
    fs.appendFileSync(logPath, `[${timestamp}] [${level}] ${message}\n`);
  } catch {
    // Fail silently to prevent process crash
  }
}

// Redirect all standard console methods to the file
console.log = (...args: any[]) => writeLog('INFO', ...args);
console.info = (...args: any[]) => writeLog('INFO', ...args);
console.warn = (...args: any[]) => writeLog('WARN', ...args);
console.debug = (...args: any[]) => writeLog('DEBUG', ...args);
console.error = (...args: any[]) => writeLog('ERROR', ...args);
