import { DBService } from '../db/database.ts';
import { throwIfAborted } from './statuses.ts';

export type RunnerTimeoutBudgets = {
  providerExecutionMs: number;
  navigationMs?: number;
  inputReadyMs?: number;
  submissionMs?: number;
  firstTokenMs?: number;
  outputStabilizationMs?: number;
};

export type RunnerExecuteOptions = {
  pasteOnly?: boolean;
  signal?: AbortSignal;
  timeouts?: Partial<RunnerTimeoutBudgets>;
  attemptNo?: number;
};

export class ApiRunner {
  private runId: string;
  private taskId: string;
  private providerId: string;
  private manageRunStatus: boolean;

  constructor(
    runId: string,
    taskId: string,
    providerId: string = 'chatgpt',
    options: { manageRunStatus?: boolean } = {}
  ) {
    this.runId = runId;
    this.taskId = taskId;
    this.providerId = providerId.toLowerCase();
    this.manageRunStatus = options.manageRunStatus ?? true;
  }

  public async close(): Promise<void> {
    // No browser contexts to tear down
  }

  /**
   * Executes prompt via direct API fetch requests, preserving the SQLite Audit Trail.
   */
  public async executeTask(
    prompt: string, 
    _unusedPoolItem?: any, 
    options: RunnerExecuteOptions = {}
  ): Promise<string> {
    const signal = options.signal;
    throwIfAborted(signal);

    // 1. Log Run and Task to the Audit Trail DB
    DBService.createRun(this.runId, prompt.substring(0, 100));
    DBService.createTask({
      taskId: this.taskId,
      runId: this.runId,
      providerName: this.providerId,
      promptPayload: prompt,
      status: 'IN_PROGRESS',
      attemptNo: options.attemptNo ?? 1,
    });

    try {
      let responseText = '';

      if (this.providerId === 'mock') {
        if (prompt.includes('selected_option_id')) {
          if (prompt.includes('option_evaluations')) {
            responseText = JSON.stringify({
              selected_option_id: 'sqlite',
              option_evaluations: [
                {
                  option_id: 'sqlite',
                  criterion_evaluations: [
                    {
                      criterion_id: 'c1',
                      rating: 5,
                      justification: 'Highly rated.'
                    }
                  ],
                  summary: 'Excellent choice.'
                },
                {
                  option_id: 'postgres',
                  criterion_evaluations: [
                    {
                      criterion_id: 'c1',
                      rating: 3,
                      justification: 'Overkill for simple cases.'
                    }
                  ],
                  summary: 'Good but complex.'
                }
              ],
              decision_justification: 'SQLite is simpler and meets all requirements.',
              confidence: 0.95,
              assumptions: ['No scaling issues expected.']
            });
          } else {
            const optionMatch = prompt.match(/-\s*\[([^\]]+)\]/);
            const selectedId = optionMatch ? optionMatch[1] : 'sqlite';
            responseText = JSON.stringify({
              selected_option_id: selectedId,
              decision_justification: 'Selected based on simplicity and ease of use.',
              confidence: 0.9,
              assumptions: ['Assume single-user or low concurrency application.']
            });
          }
        } else {
          responseText = `[Mock Response from ${this.providerId}] for: ${prompt.substring(0, 60)}...`;
        }
      } else if (this.providerId === 'openai' || this.providerId === 'chatgpt') {
        responseText = await this.callOpenAI(prompt, signal);
      } else if (this.providerId === 'claude' || this.providerId === 'anthropic') {
        responseText = await this.callAnthropic(prompt, signal);
      } else if (this.providerId === 'gemini') {
        responseText = await this.callGemini(prompt, signal);
      } else {
        throw new Error(`Unsupported API provider: ${this.providerId}`);
      }

      throwIfAborted(signal);

      // 2. Log Success to Audit Trail DB
      DBService.updateTaskResponse({
        taskId: this.taskId,
        responseText,
        extractionMethod: 'api',
        status: 'COMPLETED',
      });
      
      if (this.manageRunStatus) {
        DBService.updateRunStatusIfNotTerminal(this.runId, 'COMPLETED');
      }

      return responseText;
    } catch (error: any) {
      const cancelled = signal?.aborted;
      
      // 3. Log Failures/Cancellations to Audit Trail DB
      DBService.failTaskWithClassification(
        this.taskId,
        cancelled ? 'CANCELLED' : 'FAILED',
        cancelled ? 'ABORTED' : 'UNKNOWN',
        false
      );
      
      if (this.manageRunStatus) {
        DBService.updateRunStatusIfNotTerminal(this.runId, cancelled ? 'CANCELLED' : 'FAILED');
      }

      throw error;
    }
  }

  /* ------------------ Official API Connectors ------------------ */

  private async callOpenAI(prompt: string, signal?: AbortSignal): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY env variable is missing.');

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }]
      }),
      signal
    });

    if (!res.ok) throw new Error(`OpenAI API error: ${res.statusText} (${await res.text()})`);
    const data = await res.json() as any;
    return data.choices[0]?.message?.content || '';
  }

  private async callAnthropic(prompt: string, signal?: AbortSignal): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY env variable is missing.');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal
    });

    if (!res.ok) throw new Error(`Anthropic API error: ${res.statusText} (${await res.text()})`);
    const data = await res.json() as any;
    return data.content[0]?.text || '';
  }

  private async callGemini(prompt: string, signal?: AbortSignal): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY env variable is missing.');

    const model = 'gemini-1.5-pro';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      }),
      signal
    });

    if (!res.ok) throw new Error(`Gemini API error: ${res.statusText} (${await res.text()})`);
    const data = await res.json() as any;
    return data.candidates[0]?.content?.parts[0]?.text || '';
  }
}

// Map exports expected by other files
export const OrchestrationRunner = ApiRunner;
export type SessionPoolItem = any;
