import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { EventEmitter } from 'events';

export interface ResearchTask {
    name: string;
    schedule: string;        // cron expression e.g. "0 7 * * *"
    question: string;        // the research question
    sources?: string[];      // optional list of URLs/domains to prioritize
    model?: string;          // model to use (defaults to local if available)
    enabled: boolean;
}

export interface Finding {
    id: string;
    taskName: string;
    summary: string;
    fullReport: string;
    timestamp: string;
    read: boolean;
}

export class AgentScheduler extends EventEmitter {
    private tasks: ResearchTask[] = [];
    private pendingFindings: Finding[] = [];
    private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private running = false;
    private relayUrl = 'wss://mellow-backend.onrender.com';
    private authToken = '';

    constructor(
        private tasksConfigPath: string,
        private findingsDir: string,
    ) {
        super();
        fs.mkdirSync(findingsDir, { recursive: true });
        this.loadTasks();
        this.loadUnreadFindings();
    }

    setRelay(relayUrl: string, authToken: string): void {
        this.relayUrl = relayUrl;
        this.authToken = authToken;
    }

    start(): void {
        this.running = true;
        this.scheduleTasks();
        // Re-read config every 5 minutes to pick up edits
        setInterval(() => { this.loadTasks(); this.scheduleTasks(); }, 5 * 60 * 1000);
    }

    stop(): void {
        this.running = false;
        for (const timer of this.timers.values()) { clearTimeout(timer); }
        this.timers.clear();
    }

    getTaskNames(): string[] {
        return this.tasks.filter(t => t.enabled).map(t => t.name);
    }

    getTasks(): ResearchTask[] {
        return this.tasks;
    }

    getPendingFindings(): Finding[] {
        return this.pendingFindings.filter(f => !f.read);
    }

    clearFinding(id: string): void {
        const f = this.pendingFindings.find(p => p.id === id);
        if (f) { f.read = true; this.saveFinding(f); }
    }

    async runNow(taskName: string): Promise<void> {
        const task = this.tasks.find(t => t.name === taskName);
        if (!task) { return; }
        await this.runTask(task);
    }

    private loadTasks(): void {
        try {
            if (!fs.existsSync(this.tasksConfigPath)) {
                this.writeDefaultConfig();
            }
            const raw = fs.readFileSync(this.tasksConfigPath, 'utf-8');
            this.tasks = parseYamlTasks(raw);
        } catch (e) {
            console.error('[scheduler] Failed to load tasks:', e);
        }
    }

    private loadUnreadFindings(): void {
        try {
            const files = fs.readdirSync(this.findingsDir)
                .filter(f => f.endsWith('.json'))
                .sort()
                .reverse()
                .slice(0, 50);
            this.pendingFindings = files.map(f => {
                try { return JSON.parse(fs.readFileSync(path.join(this.findingsDir, f), 'utf-8')); }
                catch { return null; }
            }).filter(Boolean);
        } catch { this.pendingFindings = []; }
    }

    private scheduleTasks(): void {
        for (const timer of this.timers.values()) { clearTimeout(timer); }
        this.timers.clear();
        for (const task of this.tasks) {
            if (task.enabled) { this.scheduleNext(task); }
        }
    }

    private scheduleNext(task: ResearchTask): void {
        const msUntilNext = msUntilNextCron(task.schedule);
        const timer = setTimeout(async () => {
            await this.runTask(task);
            this.scheduleNext(task);
        }, msUntilNext);
        this.timers.set(task.name, timer);
    }

    private async runTask(task: ResearchTask): Promise<void> {
        console.log(`[scheduler] Running task: ${task.name}`);
        try {
            const report = await this.doResearch(task);
            const finding: Finding = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                taskName: task.name,
                summary: extractSummary(report),
                fullReport: report,
                timestamp: new Date().toISOString(),
                read: false,
            };
            this.pendingFindings.unshift(finding);
            if (this.pendingFindings.length > 50) { this.pendingFindings.pop(); }
            this.saveFinding(finding);
            this.emit('taskComplete', finding);
        } catch (e) {
            console.error(`[scheduler] Task ${task.name} failed:`, e);
        }
    }

    private async doResearch(task: ResearchTask): Promise<string> {
        // Build a research prompt using the iterative approach from Odysseus
        const systemPrompt = `You are a research assistant. Conduct thorough research on the given question.
Use web search to find recent information. After searching, synthesize findings into a clear report.
Focus on what's NEW since the last time this topic was researched.
End your report with a one-sentence TL;DR prefixed with "SUMMARY: ".`;

        const userPrompt = task.question + (task.sources?.length
            ? `\n\nPrioritize these sources: ${task.sources.join(', ')}`
            : '');

        // Send to relay and collect response
        return new Promise((resolve, reject) => {
            const { WebSocket } = require('ws');
            const ws = new WebSocket(this.relayUrl, { maxPayload: 20 * 1024 * 1024 });
            let buffer = '';
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error('Research task timed out'));
            }, 5 * 60 * 1000);

            ws.on('open', () => {
                ws.send(JSON.stringify({ type: 'auth', token: this.authToken, role: 'client' }));
            });

            ws.on('message', (data: Buffer) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === 'auth_ok') {
                        ws.send(JSON.stringify({
                            type: 'query',
                            prompt: userPrompt,
                            session_id: `scheduler-${task.name}-${Date.now()}`,
                            ...(task.model ? { model: task.model } : {}),
                        }));
                    } else if (msg.type === 'assistant_text_delta') {
                        buffer += msg.text;
                    } else if (msg.type === 'done' || msg.type === 'result') {
                        clearTimeout(timeout);
                        ws.close();
                        resolve(buffer || 'No output');
                    } else if (msg.type === 'error') {
                        clearTimeout(timeout);
                        ws.close();
                        reject(new Error(msg.message));
                    }
                } catch { /* ignore parse errors */ }
            });

            ws.on('error', (e: Error) => { clearTimeout(timeout); reject(e); });
        });
    }

    private saveFinding(finding: Finding): void {
        const fname = `${finding.timestamp.replace(/[:.]/g, '-')}-${finding.id}.json`;
        fs.writeFileSync(path.join(this.findingsDir, fname), JSON.stringify(finding, null, 2));
    }

    private writeDefaultConfig(): void {
        fs.mkdirSync(path.dirname(this.tasksConfigPath), { recursive: true });
        fs.writeFileSync(this.tasksConfigPath, DEFAULT_TASKS_YAML);
    }
}

// Minimal cron expression parser (handles "minute hour * * *" patterns)
function msUntilNextCron(expr: string): number {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) { return 60 * 60 * 1000; } // fallback: 1 hour
    const [minute, hour] = parts.map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setMinutes(minute);
    next.setHours(hour);
    if (next <= now) { next.setDate(next.getDate() + 1); }
    return next.getTime() - now.getTime();
}

function extractSummary(report: string): string {
    const match = report.match(/SUMMARY:\s*(.+)/i);
    if (match) { return match[1].trim(); }
    return report.split('\n').filter(l => l.trim()).slice(0, 2).join(' ').substring(0, 200);
}

function parseYamlTasks(yaml: string): ResearchTask[] {
    // Minimal YAML parser for our specific format
    const tasks: ResearchTask[] = [];
    const blocks = yaml.split(/^-\s+name:/m).slice(1);
    for (const block of blocks) {
        try {
            const lines = (`- name:${block}`).split('\n');
            const get = (key: string) => {
                const line = lines.find(l => l.trim().startsWith(`${key}:`));
                return line ? line.split(`${key}:`)[1].trim().replace(/^["']|["']$/g, '') : '';
            };
            const sources = lines
                .filter(l => l.trim().startsWith('- http'))
                .map(l => l.trim().replace(/^-\s*/, ''));

            tasks.push({
                name: get('name'),
                schedule: get('schedule') || '0 8 * * *',
                question: get('question'),
                model: get('model') || undefined,
                sources: sources.length ? sources : undefined,
                enabled: get('enabled') !== 'false',
            });
        } catch { /* skip malformed block */ }
    }
    return tasks;
}

const DEFAULT_TASKS_YAML = `# JAC Research Tasks
# Runs on your local machine — edit freely, changes take effect within 5 minutes.
# Cron format: minute hour * * * (e.g. "0 7 * * *" = 7am daily)

- name: Vesuvius Challenge
  schedule: "0 7 * * *"
  question: >
    What are the latest developments in the Vesuvius Challenge (Herculaneum scroll decipherment)?
    Include: new segmentation results, ink detection breakthroughs, leaderboard changes,
    new papers on arxiv, and any forum announcements from scrollprize.org.
    Focus only on what's new in the last 48 hours.
  sources:
    - scrollprize.org
    - arxiv.org
    - github.com/ScrollPrize
  enabled: false

- name: Bioremediation Research
  schedule: "0 8 * * 1"
  question: >
    What are the latest papers and findings in bioremediation research?
    Focus on: novel organisms with remediation potential, new contaminant degradation
    pathways, regulatory approvals, and field trials. Include anything published in
    the last 7 days on PubMed, arxiv, or EPA.
  sources:
    - pubmed.ncbi.nlm.nih.gov
    - arxiv.org
    - epa.gov
  enabled: false

- name: GitHub Monitoring
  schedule: "0 9 * * *"
  question: >
    Summarize notable activity from the last 24 hours in these repos:
    - ggml-org/llama.cpp (new PRs, releases, metal/gpu changes)
    - pewdiepie-archdaemon/odysseus (new features, breaking changes)
    - anthropics/claude-code (new releases, new features)
    What's worth knowing about?
  enabled: false
`;
