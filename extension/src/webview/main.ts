/** Webview entry point — handles all DOM rendering and message routing. */
export {};

declare function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ── DOM refs ─────────────────────────────────────────────────────────────────

const messagesEl = document.getElementById('messages')!;
const inputEl = document.getElementById('prompt-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const statusEl = document.getElementById('connection-status')!;
const newConvoBtn = document.getElementById('new-convo-btn')!;
const streamingIndicator = document.getElementById('streaming-indicator')!;
const modeBtn = document.getElementById('mode-btn') as HTMLButtonElement;
const modelBtn = document.getElementById('model-btn') as HTMLButtonElement;
const attachBtn = document.getElementById('attach-btn') as HTMLButtonElement;
const titleWrapper = document.getElementById('title-wrapper')!;
const sessionDropdown = document.getElementById('session-dropdown')!;
let dropdownOpen = false;
let historyForDropdown = false;

const imagePreviewsEl = document.getElementById('image-previews') as HTMLDivElement;

let currentAssistantEl: HTMLElement | null = null;
let currentThinkingEl: HTMLElement | null = null;
let isStreaming = false;
let pendingImages: Array<{data: string; mediaType: string}> = [];

// ── Cost & context tracking ─────────────────────────────────────────────────

let sessionCost = 0;
let sessionTurns = 0;
let sessionDuration = 0;
let sessionInputTokens = 0;
let sessionOutputTokens = 0;

const CONTEXT_WINDOW = 200_000; // All current Claude models
const contextRingEl = document.getElementById('context-ring') as HTMLDivElement;

function updateContextRing(): void {
    const totalTokens = sessionInputTokens + sessionOutputTokens;
    if (totalTokens === 0) {
        contextRingEl.classList.remove('visible');
        return;
    }
    contextRingEl.classList.add('visible');

    const pct = Math.min((totalTokens / CONTEXT_WINDOW) * 100, 100);
    const r = 9; // radius
    const circumference = 2 * Math.PI * r;
    const offset = circumference * (1 - pct / 100);

    let colorClass = 'green';
    if (pct >= 80) { colorClass = 'red'; }
    else if (pct >= 60) { colorClass = 'orange'; }

    const pctText = pct < 1 ? '<1' : Math.round(pct).toString();
    const tokensK = (totalTokens / 1000).toFixed(0);
    const windowK = (CONTEXT_WINDOW / 1000).toFixed(0);

    contextRingEl.title = `Context: ${pctText}% (${tokensK}k / ${windowK}k tokens)`;
    contextRingEl.innerHTML =
        `<svg viewBox="0 0 24 24">` +
        `<circle cx="12" cy="12" r="${r}" class="ring-bg"/>` +
        `<circle cx="12" cy="12" r="${r}" class="ring-progress ${colorClass}" ` +
        `stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>` +
        `<text x="12" y="12" class="ring-text">${pctText}</text>` +
        `</svg>`;
}

// ── Permission mode ─────────────────────────────────────────────────────────

type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
type UIMode = PermissionMode | 'council';

const MODE_LABELS: Record<UIMode, string> = {
    default: 'Ask',
    acceptEdits: 'Auto-edit',
    plan: 'Plan',
    bypassPermissions: 'Bypass',
    council: 'Council',
};

const MODE_CYCLE: UIMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'council'];

let currentMode: UIMode = 'bypassPermissions';

const inputContainer = document.getElementById('input-container') as HTMLDivElement;

function updateModeButton(): void {
    modeBtn.textContent = MODE_LABELS[currentMode];
    modeBtn.className = 'mode-' + currentMode;
    modeBtn.title = currentMode === 'council'
        ? `Council mode: ${councilModeType} (click to change)`
        : 'Mode: ' + MODE_LABELS[currentMode] + ' (click to change)';
    sendBtn.className = 'mode-' + currentMode;
    inputContainer.className = 'mode-' + currentMode;
}

modeBtn.addEventListener('click', () => {
    // If council is active and user clicks, exit council and go to next mode
    if (councilActive) {
        councilActive = false;
    }

    const idx = MODE_CYCLE.indexOf(currentMode);
    currentMode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];

    if (currentMode === 'council') {
        // Show council setup popup
        showCouncilSetup();
    } else {
        // Regular permission mode
        vscode.postMessage({ type: 'set_permission_mode', mode: currentMode });
    }
    updateModeButton();
});

updateModeButton();

// ── Show welcome screen ──────────────────────────────────────────────────────

// Fallback greetings shown instantly — replaced by Claude-generated ones when connected
const FALLBACK_GREETINGS = [
    "What shall we build today?",
    "Ready to make something awesome.",
    "Standing by for brilliance.",
    "Let's ship it.",
];

function showWelcome(): void {
    messagesEl.innerHTML = '';
    const welcome = document.createElement('div');
    welcome.className = 'welcome-screen';
    welcome.id = 'welcome';
    const fallback = FALLBACK_GREETINGS[Math.floor(Math.random() * FALLBACK_GREETINGS.length)];
    welcome.innerHTML =
        '<div class="welcome-icon">JAC</div>' +
        '<div class="welcome-subtitle" id="welcome-subtitle">' + escHtml(fallback) + '</div>';
    messagesEl.appendChild(welcome);
    // Ask the extension host to get Claude to generate a greeting
    vscode.postMessage({ type: 'generate_greeting' });
}

showWelcome();

// ── Slash commands ──────────────────────────────────────────────────────────

interface SlashCommand {
    name: string;
    description: string;
    local?: () => void;
}

let currentModel = 'sonnet';
let currentProviderId = '';
let modelPickerTab: 'cloud' | 'local' = 'cloud';

function pickProviderId(modelId: string): string {
    const preferred = preferredMachineId
        ? availableModels.find(m => m.id === modelId && (m.provider_id === preferredMachineId || m.machine_id === preferredMachineId))
        : null;
    const match = preferred || availableModels.find(m => m.id === modelId);
    return match?.provider_id || match?.machine_id || '';
}

// Dynamic model lists
let availableModels: Array<{id: string; label: string; provider_id?: string; machine_id?: string}> = [
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
    { id: 'haiku', label: 'Haiku' },
];

let localModels: Array<{id: string; label: string; size: string; status: 'ready' | 'downloading' | 'not_downloaded'; est_tok_s?: number}> = [];

// Persisted model prefs (synced from extension globalState)
let favoriteModels: Set<string> = new Set();
let defaultModel = '';
let preferredMachineId = '';
let modelSearchQuery = '';
let pendingDefaultApply = false;

function updateModelButton(): void {
    const cloud = availableModels.find(m => m.id === currentModel);
    const local = localModels.find(m => m.id === currentModel);
    const m = cloud || local;
    if (m) {
        modelBtn.textContent = m.label;
        modelBtn.classList.toggle('model-local', !!local);
    } else {
        modelBtn.textContent = currentModel;
    }
}

function showModelPicker(): void {
    slashMenuEl.innerHTML = '';
    slashMenuEl.style.maxHeight = '400px';
    slashMenuEl.style.overflowY = 'auto';

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'model-picker-tabs';

    const cloudTab = document.createElement('button');
    cloudTab.className = 'model-picker-tab' + (modelPickerTab === 'cloud' ? ' active' : '');
    cloudTab.textContent = 'Cloud';
    cloudTab.addEventListener('click', (e) => {
        e.stopPropagation();
        modelPickerTab = 'cloud';
        showModelPicker();
    });

    const localTab = document.createElement('button');
    localTab.className = 'model-picker-tab' + (modelPickerTab === 'local' ? ' active' : '');
    localTab.textContent = 'Local';
    localTab.addEventListener('click', (e) => {
        e.stopPropagation();
        modelPickerTab = 'local';
        vscode.postMessage({ type: 'get_local_models' });
        showModelPicker();
    });

    tabBar.appendChild(cloudTab);
    tabBar.appendChild(localTab);
    slashMenuEl.appendChild(tabBar);

    // Search input (cloud only — local list is small)
    if (modelPickerTab === 'cloud') {
        const searchWrap = document.createElement('div');
        searchWrap.style.padding = '6px 8px';
        searchWrap.style.position = 'sticky';
        searchWrap.style.top = '0';
        searchWrap.style.background = 'var(--vscode-editor-background, #1e1e1e)';
        searchWrap.style.zIndex = '10';
        searchWrap.style.borderBottom = '1px solid var(--vscode-widget-border, #333)';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search models...';
        searchInput.value = modelSearchQuery;
        searchInput.style.width = '100%';
        searchInput.style.padding = '4px 8px';
        searchInput.style.background = 'var(--vscode-input-background, #2a2a2a)';
        searchInput.style.color = 'var(--vscode-input-foreground, #ddd)';
        searchInput.style.border = '1px solid var(--vscode-input-border, #444)';
        searchInput.style.borderRadius = '3px';
        searchInput.style.fontSize = '12px';
        searchInput.style.outline = 'none';
        searchInput.addEventListener('click', (e) => e.stopPropagation());
        searchInput.addEventListener('input', () => {
            modelSearchQuery = searchInput.value;
            renderCloudList();
        });
        searchWrap.appendChild(searchInput);
        slashMenuEl.appendChild(searchWrap);

        // Container for the scrollable list
        const listContainer = document.createElement('div');
        listContainer.id = 'model-list-container';
        slashMenuEl.appendChild(listContainer);

        // Autofocus (deferred so VS Code webview lets it take)
        setTimeout(() => searchInput.focus(), 0);

        const renderCloudList = (): void => {
            listContainer.innerHTML = '';

            if (availableModels.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'slash-item';
                empty.style.opacity = '0.5';
                empty.textContent = 'No cloud models available — check bridge connection';
                listContainer.appendChild(empty);
                return;
            }

            const q = modelSearchQuery.toLowerCase().trim();
            const filtered = q
                ? availableModels.filter(m =>
                    m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
                : availableModels;

            // Sort: favorites first (by label), then the rest
            const favs = filtered.filter(m => favoriteModels.has(m.id))
                .sort((a, b) => a.label.localeCompare(b.label));
            const rest = filtered.filter(m => !favoriteModels.has(m.id));

            if (favs.length > 0) {
                const favHeader = document.createElement('div');
                favHeader.textContent = 'Favorites';
                favHeader.style.padding = '4px 10px';
                favHeader.style.fontSize = '10px';
                favHeader.style.opacity = '0.5';
                favHeader.style.textTransform = 'uppercase';
                favHeader.style.letterSpacing = '0.5px';
                listContainer.appendChild(favHeader);
                favs.forEach(m => listContainer.appendChild(buildCloudItem(m)));

                if (rest.length > 0) {
                    const allHeader = document.createElement('div');
                    allHeader.textContent = 'All models';
                    allHeader.style.padding = '8px 10px 4px';
                    allHeader.style.fontSize = '10px';
                    allHeader.style.opacity = '0.5';
                    allHeader.style.textTransform = 'uppercase';
                    allHeader.style.letterSpacing = '0.5px';
                    listContainer.appendChild(allHeader);
                }
            }
            rest.forEach(m => listContainer.appendChild(buildCloudItem(m)));

            if (filtered.length === 0) {
                const none = document.createElement('div');
                none.className = 'slash-item';
                none.style.opacity = '0.5';
                none.textContent = `No models match "${modelSearchQuery}"`;
                listContainer.appendChild(none);
            }
        };

        const buildCloudItem = (m: {id: string; label: string; provider_id?: string; machine_id?: string}): HTMLElement => {
            const isCurrent = m.id === currentModel;
            const isFav = favoriteModels.has(m.id);
            const isDefault = defaultModel === m.id;
            const item = document.createElement('div');
            item.className = 'slash-item' + (isCurrent ? ' active' : '');
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.gap = '6px';

            // Star (favorite toggle)
            const star = document.createElement('span');
            star.textContent = isFav ? '\u2605' : '\u2606';
            star.style.fontSize = '14px';
            star.style.cursor = 'pointer';
            star.style.color = isFav ? '#f5c518' : 'rgba(255,255,255,0.3)';
            star.style.flexShrink = '0';
            star.title = isFav ? 'Unfavorite' : 'Favorite';
            star.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isFav) { favoriteModels.delete(m.id); }
                else { favoriteModels.add(m.id); }
                vscode.postMessage({
                    type: 'set_model_favorites',
                    favorites: Array.from(favoriteModels),
                });
                renderCloudList();
            });

            // Check mark (default toggle)
            const check = document.createElement('span');
            check.textContent = isDefault ? '\u2713' : '\u25CB';
            check.style.fontSize = '12px';
            check.style.cursor = 'pointer';
            check.style.color = isDefault ? '#4ec990' : 'rgba(255,255,255,0.3)';
            check.style.flexShrink = '0';
            check.title = isDefault ? 'Default on startup' : 'Set as default';
            check.addEventListener('click', (e) => {
                e.stopPropagation();
                defaultModel = isDefault ? '' : m.id;
                vscode.postMessage({
                    type: 'set_default_model',
                    model: defaultModel,
                });
                renderCloudList();
            });

            const nameSpan = document.createElement('span');
            nameSpan.className = 'slash-name';
            nameSpan.textContent = m.label;
            nameSpan.style.flex = '1';
            nameSpan.style.minWidth = '0';
            nameSpan.style.overflow = 'hidden';
            nameSpan.style.textOverflow = 'ellipsis';
            nameSpan.style.whiteSpace = 'nowrap';

            const descSpan = document.createElement('span');
            descSpan.className = 'slash-desc';
            descSpan.style.fontSize = '10px';
            descSpan.style.opacity = '0.5';
            descSpan.style.flexShrink = '0';
            descSpan.textContent = isCurrent ? '(current)' : '';

            item.appendChild(star);
            item.appendChild(check);
            item.appendChild(nameSpan);
            item.appendChild(descSpan);
            item.addEventListener('click', () => {
                currentModel = m.id;
                currentProviderId = m.provider_id || m.machine_id || '';  // explicit click uses exact model's machine
                vscode.postMessage({ type: 'set_model', model: m.id, provider_id: currentProviderId });
                hideSlashMenu();
                updateModelButton();
                removeWelcome();
                appendMessage('assistant', `Model changed to **${m.label}** (\`${m.id}\`)`);
            });
            return item;
        };

        renderCloudList();
    } else {
        // Local models
        if (localModels.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'slash-item';
            empty.style.opacity = '0.5';
            empty.style.flexDirection = 'column';
            empty.style.alignItems = 'flex-start';
            empty.style.gap = '4px';
            empty.innerHTML = '<span>No local models yet</span><span style="font-size:10px;opacity:0.6">Local models run on your machine via llama.cpp — no internet needed</span>';
            slashMenuEl.appendChild(empty);

            // Add model button
            const addBtn = document.createElement('div');
            addBtn.className = 'slash-item';
            addBtn.style.color = 'var(--accent)';
            addBtn.style.fontWeight = '600';
            const addIcon = document.createElement('span');
            addIcon.className = 'slash-name';
            addIcon.textContent = '+ Download a model';
            const addDesc = document.createElement('span');
            addDesc.className = 'slash-desc';
            addDesc.textContent = 'Browse available models';
            addBtn.appendChild(addIcon);
            addBtn.appendChild(addDesc);
            addBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'browse_local_models' });
                hideSlashMenu();
            });
            slashMenuEl.appendChild(addBtn);
        } else {
            localModels.forEach((m) => {
                const isCurrent = m.id === currentModel;
                const item = document.createElement('div');
                item.className = 'slash-item' + (isCurrent ? ' active' : '');
                item.style.display = 'flex';
                item.style.alignItems = 'center';
                item.style.gap = '8px';

                // Left section: name + meta
                const left = document.createElement('div');
                left.style.flex = '1';
                left.style.minWidth = '0';
                left.style.display = 'flex';
                left.style.flexDirection = 'column';

                const nameSpan = document.createElement('span');
                nameSpan.className = 'slash-name';
                nameSpan.textContent = m.label;

                const metaParts = [m.size];
                if (m.est_tok_s) { metaParts.push(`~${m.est_tok_s} tok/s`); }
                const metaSpan = document.createElement('span');
                metaSpan.className = 'slash-desc';
                metaSpan.style.marginTop = '2px';
                metaSpan.textContent = m.status === 'downloading' ? 'downloading...' : metaParts.join('  ·  ');

                left.appendChild(nameSpan);
                left.appendChild(metaSpan);
                item.appendChild(left);

                // Right section: status indicator
                const right = document.createElement('span');
                right.style.flexShrink = '0';
                right.style.fontSize = '14px';
                right.style.lineHeight = '1';
                if (m.status === 'ready') {
                    right.textContent = '\u2713';
                    right.style.color = '#4ec990';
                    right.title = 'Ready';
                } else if (m.status === 'downloading') {
                    right.textContent = '\u2026';
                    right.style.opacity = '0.5';
                    right.title = 'Downloading';
                } else {
                    right.textContent = '\u2193';
                    right.style.opacity = '0.6';
                    right.style.cursor = 'pointer';
                    right.title = 'Download';
                }
                item.appendChild(right);

                item.addEventListener('click', () => {
                    if (m.status === 'ready') {
                        currentModel = m.id;
                        vscode.postMessage({ type: 'set_model', model: m.id, local: true });
                        hideSlashMenu();
                        updateModelButton();
                        removeWelcome();
                        appendMessage('assistant', `Switched to local model **${m.label}** (${m.size})`);
                    } else if (m.status === 'not_downloaded') {
                        vscode.postMessage({ type: 'download_local_model', model_id: m.id });
                        m.status = 'downloading';
                        showModelPicker(); // re-render
                    }
                });
                slashMenuEl.appendChild(item);
            });

        }
    }

    slashMenuEl.style.display = 'block';
    slashMenuVisible = true;
    filteredCommands = [];
}

modelBtn.addEventListener('click', () => showModelPicker());

// ── Council mode ────────────────────────────────────────────────────────────

const COUNCIL_MODES = [
    { id: 'debate', label: 'Debate', desc: 'Models critique each other\'s reasoning' },
    { id: 'brainstorm', label: 'Brainstorm', desc: 'Models build on each other\'s ideas' },
    { id: 'review', label: 'Review', desc: 'Models review like senior engineers' },
    { id: 'consensus', label: 'Consensus', desc: 'Models work toward agreement' },
];

const MODEL_COLORS: Record<string, string> = {
    'sonnet': '#c084fc',
    'opus': '#818cf8',
    'haiku': '#67e8f9',
    'gpt-4o': '#74d38e',
    'gpt-4o-mini': '#a3e635',
    'o3': '#34d399',
    'o4-mini': '#6ee7b7',
    'gemini-2.5-pro': '#60a5fa',
    'gemini-2.5-flash': '#38bdf8',
    'gemini-2.0-flash': '#7dd3fc',
};

function getModelColor(modelId: string): string {
    return MODEL_COLORS[modelId] || '#a1a1aa';
}

function showCouncilPicker(): void {
    slashMenuEl.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'slash-item';
    header.style.opacity = '0.6';
    header.style.cursor = 'default';
    header.textContent = 'Pick a council mode, then type your question:';
    slashMenuEl.appendChild(header);

    COUNCIL_MODES.forEach(mode => {
        const item = document.createElement('div');
        item.className = 'slash-item';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'slash-name';
        nameSpan.textContent = mode.label;
        const descSpan = document.createElement('span');
        descSpan.className = 'slash-desc';
        descSpan.textContent = mode.desc;
        item.appendChild(nameSpan);
        item.appendChild(descSpan);
        item.addEventListener('click', () => {
            hideSlashMenu();
            inputEl.value = `/council ${mode.id} `;
            inputEl.focus();
            autoResizeInput();
        });
        slashMenuEl.appendChild(item);
    });

    slashMenuEl.style.display = 'block';
    slashMenuVisible = true;
}

let councilActive = false;
let councilModeType: string = 'debate';
let councilModels: string[] = [];

function toggleCouncilMode(): void {
    if (councilActive) {
        councilActive = false;
        currentMode = 'bypassPermissions';
        vscode.postMessage({ type: 'set_permission_mode', mode: currentMode });
        updateModeButton();
    } else {
        showCouncilSetup();
    }
}

function showCouncilSetup(): void {
    slashMenuEl.innerHTML = '';

    // Step 1: Mode selection
    const modeHeader = document.createElement('div');
    modeHeader.className = 'slash-item';
    modeHeader.style.opacity = '0.6';
    modeHeader.style.cursor = 'default';
    modeHeader.textContent = 'Select discussion style:';
    slashMenuEl.appendChild(modeHeader);

    COUNCIL_MODES.forEach(mode => {
        const item = document.createElement('div');
        item.className = 'slash-item' + (councilModeType === mode.id ? ' active' : '');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'slash-name';
        nameSpan.textContent = mode.label;
        const descSpan = document.createElement('span');
        descSpan.className = 'slash-desc';
        descSpan.textContent = mode.desc;
        item.appendChild(nameSpan);
        item.appendChild(descSpan);
        item.addEventListener('click', () => {
            councilModeType = mode.id;
            // Now show model selection
            showCouncilModelPicker();
        });
        slashMenuEl.appendChild(item);
    });

    slashMenuEl.style.display = 'block';
    slashMenuVisible = true;
}

function showCouncilModelPicker(): void {
    slashMenuEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'slash-item';
    header.style.opacity = '0.6';
    header.style.cursor = 'default';
    header.textContent = 'Select models (click to toggle, then confirm):';
    slashMenuEl.appendChild(header);

    // Track selected models
    const selected = new Set<string>(councilModels.length > 0 ? councilModels : [currentModel]);

    availableModels.forEach(m => {
        const item = document.createElement('div');
        item.className = 'slash-item' + (selected.has(m.id) ? ' active' : '');
        const color = getModelColor(m.id);
        const nameSpan = document.createElement('span');
        nameSpan.className = 'slash-name';
        nameSpan.innerHTML = `<span class="council-model-badge" style="background:${color}; display:inline-block; margin-right:6px;">${m.label}</span>`;
        const descSpan = document.createElement('span');
        descSpan.className = 'slash-desc';
        descSpan.textContent = selected.has(m.id) ? 'selected' : 'click to add';
        item.appendChild(nameSpan);
        item.appendChild(descSpan);
        item.addEventListener('click', () => {
            if (selected.has(m.id)) {
                selected.delete(m.id);
                item.classList.remove('active');
                descSpan.textContent = 'click to add';
            } else {
                selected.add(m.id);
                item.classList.add('active');
                descSpan.textContent = 'selected';
            }
        });
        slashMenuEl.appendChild(item);
    });

    // Confirm button
    const confirm = document.createElement('div');
    confirm.className = 'slash-item';
    confirm.style.color = 'var(--accent)';
    confirm.style.fontWeight = '600';
    confirm.style.justifyContent = 'center';
    confirm.textContent = `Start Council (${councilModeType})`;
    confirm.addEventListener('click', () => {
        councilModels = Array.from(selected);
        if (councilModels.length < 1) { councilModels = [currentModel]; }
        councilActive = true;
        hideSlashMenu();
        currentMode = 'council';
        updateModeButton();
        removeWelcome();
        const modelNames = councilModels.map(id => {
            const m = availableModels.find(am => am.id === id);
            return m ? m.label : id;
        }).join(', ');
        appendMessage('assistant', `*Council mode activated — **${councilModeType}** with ${modelNames}. Every message will be discussed by all models.*`);
    });
    slashMenuEl.appendChild(confirm);

    slashMenuEl.style.display = 'block';
    slashMenuVisible = true;
}

const SLASH_COMMANDS: SlashCommand[] = [
    { name: '/clear', description: 'Clear conversation and start fresh', local: () => {
        autoSaveConversation();
        vscode.postMessage({ type: 'new_conversation' });
        sessionCost = 0; sessionTurns = 0; sessionDuration = 0;
        sessionInputTokens = 0; sessionOutputTokens = 0;
        updateContextRing();
    }},
    { name: '/compact', description: 'Compact conversation to free context' },
    { name: '/cost', description: 'Show token usage statistics', local: () => {
        removeWelcome();
        const totalTokens = sessionInputTokens + sessionOutputTokens;
        const pct = CONTEXT_WINDOW > 0 ? ((totalTokens / CONTEXT_WINDOW) * 100).toFixed(1) : '0';
        appendMessage('assistant',
            '**Session Stats**\n' +
            `Total cost: **$${sessionCost.toFixed(4)}**\n` +
            `Total turns: **${sessionTurns}**\n` +
            `Total time: **${(sessionDuration / 1000).toFixed(1)}s**\n` +
            `Input tokens: **${sessionInputTokens.toLocaleString()}**\n` +
            `Output tokens: **${sessionOutputTokens.toLocaleString()}**\n` +
            `Context used: **${pct}%** (${totalTokens.toLocaleString()} / ${CONTEXT_WINDOW.toLocaleString()})\n` +
            `Model: **${currentModel}**`
        );
    }},
    { name: '/help', description: 'Show available commands', local: showSlashHelp },
    { name: '/history', description: 'Browse past conversations', local: () => {
        vscode.postMessage({ type: 'load_history' });
    }},
    { name: '/init', description: 'Initialize project with CLAUDE.md' },
    { name: '/model', description: 'Change AI model', local: showModelPicker },
    { name: '/plan', description: 'Enter plan mode' },
    { name: '/chain', description: 'Chain skills in sequence (e.g. /chain review ship)' },
    { name: '/plan-ceo-review', description: 'Founder-mode architectural review (gstack)' },
    { name: '/plan-eng-review', description: 'Engineering leadership plan review (gstack)' },
    { name: '/retro', description: 'Weekly engineering retrospective (gstack)' },
    { name: '/review', description: 'Pre-landing PR review (gstack)' },
    { name: '/ship', description: 'Automated release workflow (gstack)' },
    { name: '/skills', description: 'List all available skills (built-in + custom)' },
    { name: '/council', description: 'Multi-model debate (e.g. /council debate Should we use React or Vue?)', local: () => {
        showCouncilPicker();
    }},
    { name: '/status', description: 'Show connection status', local: () => {
        removeWelcome();
        appendMessage('assistant',
            '**Status**\n' +
            `Connection: ${statusEl.textContent || 'unknown'}\n` +
            `Mode: **${MODE_LABELS[currentMode]}**\n` +
            `Model: **${currentModel}**\n` +
            `Session cost: **$${sessionCost.toFixed(4)}**`
        );
    }},
];

const slashMenuEl = document.getElementById('slash-menu') as HTMLDivElement;
let slashMenuVisible = false;
let slashActiveIdx = 0;
let filteredCommands: SlashCommand[] = [];

function showSlashHelp(): void {
    const lines = SLASH_COMMANDS.map(c => `**${c.name}** — ${c.description}`).join('\n');
    removeWelcome();
    appendMessage('assistant', '**Available commands:**\n' + lines);
}

function updateSlashMenu(): void {
    const val = inputEl.value;
    if (!val.startsWith('/') || isStreaming) {
        hideSlashMenu();
        return;
    }
    const query = val.slice(1).toLowerCase();
    filteredCommands = SLASH_COMMANDS.filter(c => c.name.slice(1).startsWith(query));
    if (filteredCommands.length === 0) {
        hideSlashMenu();
        return;
    }
    slashActiveIdx = Math.min(slashActiveIdx, filteredCommands.length - 1);
    slashMenuEl.innerHTML = '';
    filteredCommands.forEach((cmd, i) => {
        const item = document.createElement('div');
        item.className = 'slash-item' + (i === slashActiveIdx ? ' active' : '');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'slash-name';
        nameSpan.textContent = cmd.name;
        const descSpan = document.createElement('span');
        descSpan.className = 'slash-desc';
        descSpan.textContent = cmd.description;
        item.appendChild(nameSpan);
        item.appendChild(descSpan);
        item.addEventListener('mouseenter', () => {
            slashActiveIdx = i;
            updateSlashHighlight();
        });
        item.addEventListener('click', () => selectSlashCommand(cmd));
        slashMenuEl.appendChild(item);
    });
    slashMenuEl.style.display = 'block';
    slashMenuVisible = true;
}

function updateSlashHighlight(): void {
    const items = slashMenuEl.querySelectorAll('.slash-item');
    items.forEach((el, i) => {
        el.classList.toggle('active', i === slashActiveIdx);
    });
}

function hideSlashMenu(): void {
    slashMenuEl.style.display = 'none';
    slashMenuVisible = false;
    slashActiveIdx = 0;
    filteredCommands = [];
}

// Close slash/model menu when clicking outside
document.addEventListener('click', (e) => {
    if (!slashMenuVisible) { return; }
    const target = e.target as HTMLElement;
    if (!slashMenuEl.contains(target) && target !== modelBtn) {
        hideSlashMenu();
    }
});

function selectSlashCommand(cmd: SlashCommand): void {
    hideSlashMenu();
    inputEl.value = '';
    autoResizeInput();
    if (cmd.local) {
        cmd.local();
    } else {
        // Send the command as a query
        removeWelcome();
        appendMessage('user', cmd.name);
        vscode.postMessage({ type: 'query', prompt: cmd.name, ...(currentProviderId && { provider_id: currentProviderId }) });
        setStreaming(true);
    }
}

// ── Auto-resize textarea ─────────────────────────────────────────────────────

function autoResizeInput(): void {
    // Reset to 1 line so scrollHeight recalculates correctly
    inputEl.style.height = '0';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

inputEl.addEventListener('input', () => {
    autoResizeInput();
    updateSlashMenu();
});

// Also resize on paste and initial load
inputEl.addEventListener('paste', () => setTimeout(autoResizeInput, 0));

// ── Send prompt ──────────────────────────────────────────────────────────────

function sendPrompt(): void {
    const text = inputEl.value.trim();
    if (!text && pendingImages.length === 0) { return; }

    // Remove welcome screen if present
    const welcome = document.getElementById('welcome');
    if (welcome) { welcome.remove(); }

    appendMessage('user', text, pendingImages.length > 0 ? [...pendingImages] : undefined);
    inputEl.value = '';
    autoResizeInput();

    // Council mode: route all messages through multi-model discussion
    if (councilActive && councilModels.length > 0) {
        vscode.postMessage({
            type: 'council_query',
            prompt: text,
            models: councilModels,
            mode: councilModeType,
            rounds: 1,
        });
    } else {
        // Check for explicit /council command
        const councilMatch = text.match(/^\/council\s+(debate|brainstorm|review|consensus)\s+(.+)/i);
        if (councilMatch) {
            const cMode = councilMatch[1].toLowerCase();
            const cPrompt = councilMatch[2];
            const cModels: string[] = [];
            const claude = availableModels.find(m => m.id === 'sonnet' || m.id === 'opus');
            const openai = availableModels.find(m => m.id === 'gpt-4o' || m.id === 'o3');
            const gemini = availableModels.find(m => m.id.includes('gemini'));
            if (claude) { cModels.push(claude.id); }
            if (openai) { cModels.push(openai.id); }
            if (gemini) { cModels.push(gemini.id); }
            if (cModels.length === 0) { cModels.push(currentModel); }
            vscode.postMessage({
                type: 'council_query',
                prompt: cPrompt,
                models: cModels,
                mode: cMode,
                rounds: 1,
            });
        } else {
            const msg: Record<string, unknown> = { type: 'query', prompt: text || 'What\'s in this image?', ...(currentProviderId && { provider_id: currentProviderId }) };
            if (pendingImages.length > 0) {
                msg.images = pendingImages;
            }
            // Send last 10 turns of history so the bridge has context even after
            // a restart or fresh session — fixes "forgetting" between messages.
            const historyTurns: Array<{role: 'user' | 'assistant', text: string}> = [];
            for (const child of messagesEl.children) {
                const el = child as HTMLElement;
                if (el.classList.contains('message')) {
                    const role = el.classList.contains('user') ? 'user' as const : 'assistant' as const;
                    const textEl = el.querySelector('.msg-text');
                    const raw = textEl?.getAttribute('data-raw') || textEl?.textContent || '';
                    if (raw) { historyTurns.push({ role, text: raw }); }
                }
            }
            // Exclude the current user message (last item) since it's already in prompt
            const recentHistory = historyTurns.slice(-21, -1).slice(-20);
            if (recentHistory.length > 0) { msg.history = recentHistory; }
            vscode.postMessage(msg);
        }
    }
    pendingImages = [];
    renderImagePreviews();
    setStreaming(true);
}

function setStreaming(active: boolean): void {
    isStreaming = active;
    if (active) {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '&#x25A0;'; // ■ stop icon
        sendBtn.classList.add('abort');
        sendBtn.title = 'Stop response';
        streamingIndicator.classList.add('active');
        const label = document.getElementById('streaming-label');
        if (label) {
            const cloud = availableModels.find(m => m.id === currentModel);
            const local = localModels.find(m => m.id === currentModel);
            const name = (cloud || local)?.label || currentModel;
            label.textContent = `${name} is responding...`;
        }
    } else {
        sendBtn.innerHTML = '&#x2191;'; // ↑ send icon
        sendBtn.classList.remove('abort');
        sendBtn.title = 'Send message';
        sendBtn.disabled = false;
        streamingIndicator.classList.remove('active');
    }
}

function abortQuery(): void {
    if (!isStreaming) { return; }
    vscode.postMessage({ type: 'abort_query' });
    appendMessage('assistant', '*Query aborted by user.*');
    currentAssistantEl = null;
    setStreaming(false);
}

sendBtn.addEventListener('click', () => {
    if (isStreaming) { abortQuery(); } else { sendPrompt(); }
});
inputEl.addEventListener('keydown', (e) => {
    if (slashMenuVisible) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            slashActiveIdx = (slashActiveIdx + 1) % filteredCommands.length;
            updateSlashHighlight();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            slashActiveIdx = (slashActiveIdx - 1 + filteredCommands.length) % filteredCommands.length;
            updateSlashHighlight();
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            selectSlashCommand(filteredCommands[slashActiveIdx]);
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            hideSlashMenu();
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            // Tab-complete the command name
            inputEl.value = filteredCommands[slashActiveIdx].name;
            updateSlashMenu();
            return;
        }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
    }
});

document.getElementById('pair-btn')!.addEventListener('click', () => {
    vscode.postMessage({ type: 'pair_phone' });
});

newConvoBtn.addEventListener('click', () => {
    autoSaveConversation();
    vscode.postMessage({ type: 'new_conversation' });
    sessionCost = 0; sessionTurns = 0; sessionDuration = 0;
    sessionInputTokens = 0; sessionOutputTokens = 0;
    updateContextRing();
});

// Save conversation before the webview is destroyed
window.addEventListener('beforeunload', () => {
    autoSaveConversation();
});

// ── Session dropdown ────────────────────────────────────────────────────────

titleWrapper.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dropdownOpen) {
        closeDropdown();
    } else {
        historyForDropdown = true;
        vscode.postMessage({ type: 'load_history' });
    }
});

document.addEventListener('click', () => {
    if (dropdownOpen) { closeDropdown(); }
});

sessionDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
});

function closeDropdown(): void {
    sessionDropdown.style.display = 'none';
    dropdownOpen = false;
    titleWrapper.classList.remove('open');
}

function populateDropdown(conversations: Array<{id: string; title: string; timestamp: number; model: string; cost: number; turns: number}>): void {
    sessionDropdown.innerHTML = '';

    // "New conversation" item at top
    const newItem = document.createElement('div');
    newItem.className = 'dropdown-item dropdown-new';
    newItem.innerHTML = '<span class="dropdown-new-icon">+</span> New conversation';
    newItem.addEventListener('click', () => {
        autoSaveConversation();
        vscode.postMessage({ type: 'new_conversation' });
        sessionCost = 0; sessionTurns = 0; sessionDuration = 0;
        sessionInputTokens = 0; sessionOutputTokens = 0;
        updateContextRing();
        closeDropdown();
    });
    sessionDropdown.appendChild(newItem);

    // ── Panel launchers ──
    const panelDivider = document.createElement('div');
    panelDivider.className = 'dropdown-divider';
    sessionDropdown.appendChild(panelDivider);

    const panelLabel = document.createElement('div');
    panelLabel.className = 'dropdown-label';
    panelLabel.textContent = 'Panels';
    sessionDropdown.appendChild(panelLabel);

    const musicItem = document.createElement('div');
    musicItem.className = 'dropdown-item dropdown-panel';
    musicItem.innerHTML = '<span class="dropdown-panel-icon">&#x266B;</span> Music';
    musicItem.addEventListener('click', () => {
        vscode.postMessage({ type: 'open_panel', panel: 'music' });
        closeDropdown();
    });
    sessionDropdown.appendChild(musicItem);

    const browserItem = document.createElement('div');
    browserItem.className = 'dropdown-item dropdown-panel';
    browserItem.innerHTML = '<span class="dropdown-panel-icon">&#x25CE;</span> Browser';
    browserItem.addEventListener('click', () => {
        vscode.postMessage({ type: 'open_panel', panel: 'browser' });
        closeDropdown();
    });
    sessionDropdown.appendChild(browserItem);

    const cadItem = document.createElement('div');
    cadItem.className = 'dropdown-item dropdown-panel';
    cadItem.innerHTML = '<span class="dropdown-panel-icon">&#x2B21;</span> CAD';
    cadItem.addEventListener('click', () => {
        vscode.postMessage({ type: 'open_panel', panel: 'cad' });
        closeDropdown();
    });
    sessionDropdown.appendChild(cadItem);

    if (conversations.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'dropdown-divider';
        sessionDropdown.appendChild(divider);

        const label = document.createElement('div');
        label.className = 'dropdown-label';
        label.textContent = 'Recent conversations';
        sessionDropdown.appendChild(label);

        const maxShow = Math.min(conversations.length, 10);
        for (let i = 0; i < maxShow; i++) {
            const convo = conversations[i];
            const item = document.createElement('div');
            item.className = 'dropdown-item';

            const titleSpan = document.createElement('span');
            titleSpan.className = 'dropdown-item-title';
            titleSpan.textContent = convo.title;

            const metaSpan = document.createElement('span');
            metaSpan.className = 'dropdown-item-meta';
            const d = new Date(convo.timestamp);
            const isToday = new Date().toDateString() === d.toDateString();
            metaSpan.textContent = isToday
                ? d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
                : d.toLocaleDateString([], {month: 'short', day: 'numeric'});

            item.appendChild(titleSpan);
            item.appendChild(metaSpan);
            item.addEventListener('click', () => {
                vscode.postMessage({ type: 'restore_conversation', id: convo.id });
                closeDropdown();
            });
            sessionDropdown.appendChild(item);
        }

        if (conversations.length > 10) {
            const more = document.createElement('div');
            more.className = 'dropdown-item dropdown-more';
            more.textContent = 'View all (' + conversations.length + ')...';
            more.addEventListener('click', () => {
                vscode.postMessage({ type: 'load_history' });
                closeDropdown();
                // This will trigger renderHistoryList in the messages area
            });
            sessionDropdown.appendChild(more);
        }
    }

    sessionDropdown.style.display = 'block';
    dropdownOpen = true;
    titleWrapper.classList.add('open');
}

// ── Image handling ──────────────────────────────────────────────────────────

function addImageFromFile(file: File): void {
    if (!file.type.startsWith('image/')) { return; }
    const reader = new FileReader();
    reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1];
        pendingImages.push({ data: base64, mediaType: file.type });
        renderImagePreviews();
    };
    reader.readAsDataURL(file);
}

function renderImagePreviews(): void {
    imagePreviewsEl.innerHTML = '';
    if (pendingImages.length === 0) {
        imagePreviewsEl.style.display = 'none';
        return;
    }
    imagePreviewsEl.style.display = 'flex';
    pendingImages.forEach((img, idx) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'image-preview';
        const imgEl = document.createElement('img');
        imgEl.src = 'data:' + img.mediaType + ';base64,' + img.data;
        wrapper.appendChild(imgEl);
        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.textContent = '\u00d7';
        removeBtn.addEventListener('click', () => {
            pendingImages.splice(idx, 1);
            renderImagePreviews();
        });
        wrapper.appendChild(removeBtn);
        imagePreviewsEl.appendChild(wrapper);
    });
}

// Paste images
inputEl.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) { return; }
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            if (file) { addImageFromFile(file); }
        }
    }
});

// Drag and drop
inputContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    inputContainer.classList.add('drag-over');
});
inputContainer.addEventListener('dragleave', () => {
    inputContainer.classList.remove('drag-over');
});
inputContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    inputContainer.classList.remove('drag-over');
    const files = e.dataTransfer?.files;
    if (!files) { return; }
    for (const file of files) {
        addImageFromFile(file);
    }
});

// ── Clippy file attach button ────────────────────────────────────────────────

const hiddenFileInput = document.createElement('input');
hiddenFileInput.type = 'file';
hiddenFileInput.accept = 'image/*';
hiddenFileInput.multiple = true;
hiddenFileInput.style.display = 'none';
document.body.appendChild(hiddenFileInput);

attachBtn.addEventListener('click', () => {
    hiddenFileInput.click();
});

hiddenFileInput.addEventListener('change', () => {
    const files = hiddenFileInput.files;
    if (!files) { return; }
    for (const file of files) {
        addImageFromFile(file);
    }
    // Bounce Clippy!
    attachBtn.classList.add('clippy-bounce');
    setTimeout(() => attachBtn.classList.remove('clippy-bounce'), 600);
    // Reset so same file can be re-selected
    hiddenFileInput.value = '';
});

// ── Markdown rendering ───────────────────────────────────────────────────────

function renderMarkdown(text: string): string {
    // Escape HTML first
    let html = escHtml(text);

    // Code blocks (``` ... ```) — must be processed before inline patterns
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
        const header = lang
            ? '<span class="md-codeblock-header">' + lang + '</span>'
            : '';
        return '<span class="md-codeblock">' + header + code.replace(/\n$/, '') + '</span>';
    });

    // Inline code (`...`)
    html = html.replace(/`([^`\n]+?)`/g, '<code class="inline-code">$1</code>');

    // Headers (### ... )
    html = html.replace(/^(#{1,3}) (.+)$/gm, (_match, hashes, content) => {
        const level = hashes.length as number;
        return '<span class="md-heading md-h' + level + '">' + content + '</span>';
    });

    // Bold (**...**)
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic (*...*)
    html = html.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');

    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Unordered list items (- item or * item)
    html = html.replace(/^[\-\*] (.+)$/gm, '<span class="md-list-item">\u2022 $1</span>');

    // Numbered list items (1. item)
    html = html.replace(/^\d+\. (.+)$/gm, '<span class="md-list-item">$1</span>');

    // Horizontal rule (--- or ***)
    html = html.replace(/^(---|\*\*\*)$/gm, '<span class="md-hr"></span>');

    // Block quotes (> ...)
    html = html.replace(/^&gt; (.+)$/gm, '<span class="md-blockquote">$1</span>');

    return html;
}

function escHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Conversation serialization & auto-save ──────────────────────────────────

let currentSessionId = '';

interface SerializedMsg {
    role: 'user' | 'assistant';
    text: string;
    images?: Array<{data: string; mediaType: string}>;
    tools?: Array<{name: string; id: string; args: Record<string, unknown>; result?: string; isError?: boolean}>;
    timestamp: number;
}

function serializeConversation(): SerializedMsg[] {
    const msgs: SerializedMsg[] = [];
    for (const child of messagesEl.children) {
        const el = child as HTMLElement;
        if (el.classList.contains('message')) {
            const role = el.classList.contains('user') ? 'user' as const : 'assistant' as const;
            const textEl = el.querySelector('.msg-text');
            const raw = textEl?.getAttribute('data-raw') || textEl?.textContent || '';
            const msg: SerializedMsg = { role, text: raw, timestamp: Date.now() };
            // Images
            const imgEls = el.querySelectorAll('.message-images img');
            if (imgEls.length > 0) {
                msg.images = [];
                for (const imgEl of imgEls) {
                    const src = (imgEl as HTMLImageElement).src;
                    if (src.startsWith('data:')) {
                        const [header, data] = src.split(',');
                        const mediaType = header.replace('data:', '').replace(';base64', '');
                        msg.images.push({ data, mediaType });
                    }
                }
            }
            msgs.push(msg);
        } else if (el.classList.contains('tool-block')) {
            // Attach tool info to last assistant message
            const toolName = el.querySelector('.tool-name')?.textContent || '';
            const toolId = el.dataset.toolUseId || '';
            const resultEl = el.querySelector('.result-content pre');
            const resultText = resultEl?.textContent || '';
            const isError = !!el.querySelector('.tool-result-block.error');
            if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
                const last = msgs[msgs.length - 1];
                if (!last.tools) { last.tools = []; }
                last.tools.push({ name: toolName, id: toolId, args: {}, result: resultText, isError });
            }
        }
    }
    return msgs;
}

function autoSaveConversation(): void {
    const msgs = serializeConversation();
    if (msgs.length === 0) { return; }
    vscode.postMessage({
        type: 'save_conversation',
        id: currentSessionId || 'default',
        messages: msgs,
        metadata: {
            model: currentModel,
            cost: sessionCost,
            turns: sessionTurns,
        },
    });
}

function renderHistoryList(conversations: Array<{id: string; title: string; timestamp: number; model: string; cost: number; turns: number}>): void {
    removeWelcome();
    messagesEl.innerHTML = '';

    if (conversations.length === 0) {
        appendMessage('assistant', 'No conversation history found for this workspace.');
        return;
    }

    const container = document.createElement('div');
    container.className = 'history-list';

    const heading = document.createElement('div');
    heading.className = 'history-heading';
    heading.textContent = 'Conversation History';
    container.appendChild(heading);

    for (const convo of conversations) {
        const item = document.createElement('div');
        item.className = 'history-item';

        const title = document.createElement('div');
        title.className = 'history-title';
        title.textContent = convo.title;

        const meta = document.createElement('div');
        meta.className = 'history-meta';
        const date = new Date(convo.timestamp);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        meta.textContent = `${dateStr} \u00B7 ${convo.model} \u00B7 ${convo.turns} turns \u00B7 $${convo.cost.toFixed(4)}`;

        const actions = document.createElement('div');
        actions.className = 'history-actions';

        const loadBtn = document.createElement('button');
        loadBtn.className = 'history-load-btn';
        loadBtn.textContent = 'View';
        loadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'restore_conversation', id: convo.id });
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'history-delete-btn';
        delBtn.textContent = '\u00D7';
        delBtn.title = 'Delete';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'delete_conversation', id: convo.id });
        });

        actions.appendChild(loadBtn);
        actions.appendChild(delBtn);

        item.appendChild(title);
        item.appendChild(meta);
        item.appendChild(actions);

        item.addEventListener('click', () => {
            vscode.postMessage({ type: 'restore_conversation', id: convo.id });
        });

        container.appendChild(item);
    }

    const backBtn = document.createElement('button');
    backBtn.className = 'history-back-btn';
    backBtn.textContent = '\u2190 Back to conversation';
    backBtn.addEventListener('click', () => {
        messagesEl.innerHTML = '';
        showWelcome();
    });
    container.appendChild(backBtn);

    messagesEl.appendChild(container);
    scrollToBottom();
}

function renderSavedConversation(messages: SerializedMsg[]): void {
    messagesEl.innerHTML = '';

    const banner = document.createElement('div');
    banner.className = 'history-banner';
    banner.textContent = 'Viewing saved conversation (read-only)';
    messagesEl.appendChild(banner);

    for (const msg of messages) {
        appendMessage(msg.role, msg.text, msg.images);
        if (msg.tools) {
            for (const tool of msg.tools) {
                renderToolUse({ tool_name: tool.name, tool_use_id: tool.id, args: tool.args });
                if (tool.result !== undefined) {
                    renderToolResult({ tool_use_id: tool.id, content: tool.result, is_error: tool.isError || false });
                }
            }
        }
    }
    scrollToBottom();
}

// ── Receive messages from extension host ─────────────────────────────────────

window.addEventListener('message', (event) => {
    const msg = event.data;

    // Track session_id from server messages
    if (msg.session_id && !currentSessionId) {
        currentSessionId = msg.session_id;
    }

    switch (msg.type) {
        case 'connection_status':
            renderStatus(msg.status);
            break;

        case 'assistant_text_delta':
            // Remove welcome screen
            removeWelcome();
            if (!currentAssistantEl) {
                currentAssistantEl = appendMessage('assistant', '');
            }
            {
                const textEl = currentAssistantEl.querySelector('.msg-text')!;
                const rawText = (textEl.getAttribute('data-raw') || '') + msg.text;
                textEl.setAttribute('data-raw', rawText);
                textEl.innerHTML = renderMarkdown(rawText);
            }
            scrollToBottom();
            break;

        case 'assistant_text':
            removeWelcome();
            if (!currentAssistantEl) {
                currentAssistantEl = appendMessage('assistant', msg.text);
            } else {
                const textEl = currentAssistantEl.querySelector('.msg-text')!;
                textEl.setAttribute('data-raw', msg.text);
                textEl.innerHTML = renderMarkdown(msg.text);
            }
            scrollToBottom();
            break;

        case 'tool_use':
            // Skip AskUserQuestion — rendered interactively via ask_user_question
            if ((msg.tool_name || '').includes('AskUserQuestion')) { break; }
            removeWelcome();
            // Finish thinking block when tool starts
            finishThinking();
            renderToolUse(msg);
            break;

        case 'tool_result':
            renderToolResult(msg);
            break;

        case 'tool_stream': {
            const block = [...messagesEl.querySelectorAll('.tool-block')]
                .find(b => (b as HTMLElement).dataset.toolUseId === msg.tool_use_id) as HTMLElement | undefined;
            if (block) {
                let streamEl = block.querySelector('.tool-stream-output') as HTMLPreElement | null;
                if (!streamEl) {
                    streamEl = document.createElement('pre');
                    streamEl.className = 'tool-stream-output';
                    block.querySelector('.tool-body-inner')?.appendChild(streamEl);
                    block.querySelector('.tool-body')?.classList.add('open');
                }
                streamEl.textContent += msg.content;
                scrollToBottom();
            }
            break;
        }

        case 'thinking':
            removeWelcome();
            renderThinking(msg.text);
            break;

        case 'result':
            finishThinking();
            if (msg.total_cost_usd != null) { sessionCost += msg.total_cost_usd; }
            sessionTurns += msg.num_turns || 0;
            sessionDuration += msg.duration_ms || 0;
            if (msg.usage) {
                sessionInputTokens += msg.usage.input_tokens || 0;
                sessionOutputTokens += msg.usage.output_tokens || 0;
            }
            updateContextRing();
            renderResultInfo(msg);
            currentAssistantEl = null;
            setStreaming(false);
            autoSaveConversation();
            break;

        case 'done':
            finishThinking();
            currentAssistantEl = null;
            setStreaming(false);
            break;

        case 'error':
            finishThinking();
            appendError(msg.message);
            setStreaming(false);
            currentAssistantEl = null;
            break;

        case 'conversation_reset':
            currentSessionId = '';
            messagesEl.innerHTML = '';
            currentAssistantEl = null;
            currentThinkingEl = null;
            sessionInputTokens = 0;
            sessionOutputTokens = 0;
            updateContextRing();
            setStreaming(false);
            showWelcome();
            break;

        case 'history_list':
            if (historyForDropdown) {
                historyForDropdown = false;
                populateDropdown(msg.conversations);
            } else {
                renderHistoryList(msg.conversations);
            }
            break;

        case 'conversation_loaded':
            renderSavedConversation(msg.messages);
            break;

        case 'ask_user_question':
            removeWelcome();
            finishThinking();
            renderAskUserQuestion(msg.tool_id, msg.question, msg.options, msg.multiSelect);
            break;

        case 'greeting_response': {
            const subtitleEl = document.getElementById('welcome-subtitle');
            if (subtitleEl && msg.text) {
                subtitleEl.textContent = msg.text;
            }
            break;
        }

        case 'permission_request':
            removeWelcome();
            renderPermissionRequest(msg);
            break;

        case 'permission_mode_changed':
            currentMode = msg.mode as PermissionMode;
            updateModeButton();
            break;

        case 'model_prefs':
            favoriteModels = new Set(msg.favorites || []);
            defaultModel = msg.default || '';
            preferredMachineId = msg.preferred_machine_id || '';
            pendingDefaultApply = !!defaultModel;
            break;
        case 'models_list':
            if (msg.models && msg.models.length > 0) {
                // Deduplicate by id, preferring preferred machine's entry
                {
                    const seen = new Map<string, typeof msg.models[0]>();
                    for (const m of (msg.models as typeof availableModels)) {
                        const existing = seen.get(m.id);
                        if (!existing) { seen.set(m.id, m); continue; }
                        const mIsPreferred = preferredMachineId && (m.provider_id === preferredMachineId || m.machine_id === preferredMachineId);
                        if (mIsPreferred) { seen.set(m.id, m); }
                    }
                    availableModels = Array.from(seen.values());
                }
            }
            if (msg.current_model) {
                currentModel = msg.current_model;
                currentProviderId = pickProviderId(msg.current_model);
            }
            // If no current_model from relay, ensure we have a provider for whatever model is active
            if (!currentProviderId && currentModel) {
                currentProviderId = pickProviderId(currentModel);
                if (currentProviderId) {
                    vscode.postMessage({ type: 'set_model', model: currentModel, provider_id: currentProviderId });
                }
            }
            // Last resort: if still no provider, pin to preferred machine using any model it offers
            if (!currentProviderId && preferredMachineId && availableModels.length > 0) {
                const anyFromPreferred = availableModels.find(m => m.provider_id === preferredMachineId || m.machine_id === preferredMachineId);
                if (anyFromPreferred) {
                    currentModel = anyFromPreferred.id;
                    currentProviderId = anyFromPreferred.provider_id || anyFromPreferred.machine_id || '';
                    vscode.postMessage({ type: 'set_model', model: currentModel, provider_id: currentProviderId });
                }
            }
            // Apply saved default model on first models list after startup
            if (pendingDefaultApply && defaultModel
                && availableModels.some(m => m.id === defaultModel)) {
                pendingDefaultApply = false;
                currentModel = defaultModel;
                currentProviderId = pickProviderId(defaultModel);
                vscode.postMessage({ type: 'set_model', model: defaultModel, provider_id: currentProviderId });
            }
            updateModelButton();
            if (slashMenuVisible && modelPickerTab === 'cloud') {
                showModelPicker(); // refresh picker with new model list
            }
            break;
        case 'openrouter_credits': {
            const creditsEl = document.getElementById('or-credits');
            if (creditsEl) {
                const spent = (msg.usage_usd || 0).toFixed(4);
                const daily = (msg.usage_daily_usd || 0).toFixed(4);
                const limit = msg.limit_usd;
                const remaining = msg.limit_remaining_usd;
                let text = `OR: $${spent} spent`;
                if (daily > 0) text += ` ($${daily} today)`;
                if (remaining != null) text += ` · $${remaining.toFixed(2)} left`;
                creditsEl.textContent = text;
                creditsEl.style.display = 'inline';
            }
            break;
        }
        case 'local_models_list':
            if (msg.models) {
                localModels = msg.models;
                if (slashMenuVisible && modelPickerTab === 'local') {
                    showModelPicker(); // refresh the picker
                }
            }
            break;

        // ── Council mode messages ────────────────────────────────────────
        case 'council_turn_start': {
            councilActive = true;
            setStreaming(true);
            removeWelcome();
            const color = getModelColor(msg.model_id);
            const roundInfo = msg.total_rounds > 1 ? ` (Round ${msg.round}/${msg.total_rounds})` : '';
            // Create a labeled message block for this model
            const turnHeader = document.createElement('div');
            turnHeader.className = 'council-turn-header';
            turnHeader.innerHTML = `<span class="council-model-badge" style="background:${color};">${msg.model_label}</span>${roundInfo}`;
            messagesEl.appendChild(turnHeader);
            // Start a new assistant message that will receive deltas
            currentAssistantEl = null;
            break;
        }
        case 'council_turn_complete': {
            // The deltas already built the message via assistant_text_delta handling
            // Just finalize
            currentAssistantEl = null;
            scrollToBottom();
            break;
        }
        case 'council_complete': {
            councilActive = false;
            setStreaming(false);
            const modelNames = msg.models.join(', ');
            appendMessage('assistant', `*Council complete — ${modelNames} discussed over ${msg.rounds} round(s).*`);
            break;
        }
    }
});

// ── Rendering helpers ────────────────────────────────────────────────────────

function removeWelcome(): void {
    const welcome = document.getElementById('welcome');
    if (welcome) { welcome.remove(); }
}

function appendMessage(role: 'user' | 'assistant', text: string, images?: Array<{data: string; mediaType: string}>): HTMLElement {
    // End current thinking block when a new message comes in
    finishThinking();

    const el = document.createElement('div');
    el.className = 'message ' + role;

    const label = document.createElement('div');
    label.className = 'role-label';
    if (role === 'user') {
        label.textContent = 'You';
    } else {
        const cloud = availableModels.find(m => m.id === currentModel);
        const local = localModels.find(m => m.id === currentModel);
        label.textContent = (cloud || local)?.label || currentModel;
    }
    el.appendChild(label);

    // Show image thumbnails in user messages
    if (images && images.length > 0) {
        const strip = document.createElement('div');
        strip.className = 'message-images';
        for (const img of images) {
            const imgEl = document.createElement('img');
            imgEl.src = 'data:' + img.mediaType + ';base64,' + img.data;
            strip.appendChild(imgEl);
        }
        el.appendChild(strip);
    }

    const msgText = document.createElement('div');
    msgText.className = 'msg-text';
    msgText.setAttribute('data-raw', text);
    if (text) {
        msgText.innerHTML = renderMarkdown(text);
    }
    el.appendChild(msgText);

    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
}

function getToolIcon(_toolName: string): string {
    return '';
}

function renderDiff(oldStr: string, newStr: string): HTMLElement {
    const container = document.createElement('div');
    container.className = 'diff-view';

    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');

    for (const line of oldLines) {
        const lineEl = document.createElement('div');
        lineEl.className = 'diff-line diff-removed';
        lineEl.textContent = '- ' + line;
        container.appendChild(lineEl);
    }
    for (const line of newLines) {
        const lineEl = document.createElement('div');
        lineEl.className = 'diff-line diff-added';
        lineEl.textContent = '+ ' + line;
        container.appendChild(lineEl);
    }

    return container;
}

function getToolSummary(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
        case 'Read':
            return (args.file_path as string) || '';
        case 'Edit':
            return (args.file_path as string) || '';
        case 'Write':
            return (args.file_path as string) || '';
        case 'Bash':
        case 'Monitor': {
            const cmd = (args.command as string) || '';
            return cmd.length > 80 ? cmd.substring(0, 80) + '\u2026' : cmd;
        }
        case 'Grep':
            return (args.pattern as string) || '';
        case 'Glob':
            return (args.pattern as string) || '';
        case 'WebFetch':
            return (args.url as string) || '';
        case 'WebSearch':
            return (args.query as string) || '';
        case 'NotebookEdit':
            return (args.notebook_path as string) || '';
        case 'Skill':
            return (args.skill as string) || '';
        default:
            return '';
    }
}

function renderToolUse(msg: { tool_name: string; tool_use_id: string; args: Record<string, unknown> }): void {
    // Finish any current assistant text block
    currentAssistantEl = null;

    const block = document.createElement('div');
    block.className = 'tool-block';
    block.dataset.toolUseId = msg.tool_use_id;

    const header = document.createElement('div');
    header.className = 'tool-header';

    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = msg.tool_name;

    const summary = document.createElement('span');
    summary.className = 'tool-summary';
    summary.textContent = getToolSummary(msg.tool_name, msg.args);

    const status = document.createElement('span');
    status.className = 'tool-status running';
    status.textContent = 'Running';

    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.innerHTML = '&#9654;';

    header.appendChild(name);
    header.appendChild(summary);
    header.appendChild(status);
    header.appendChild(chevron);

    header.addEventListener('click', () => {
        chevron.classList.toggle('open');
        body.classList.toggle('open');
    });

    const body = document.createElement('div');
    body.className = 'tool-body';

    const bodyInner = document.createElement('div');
    bodyInner.className = 'tool-body-inner';

    if (msg.tool_name === 'Edit' && msg.args.old_string !== undefined) {
        bodyInner.appendChild(renderDiff(
            msg.args.old_string as string,
            msg.args.new_string as string,
        ));
    } else {
        const argsStr = JSON.stringify(msg.args, null, 2);
        if (argsStr !== '{}') {
            const pre = document.createElement('pre');
            pre.textContent = argsStr;
            bodyInner.appendChild(pre);
        }
    }

    body.appendChild(bodyInner);
    block.appendChild(header);
    block.appendChild(body);
    messagesEl.appendChild(block);
    scrollToBottom();
}

function renderToolResult(msg: { tool_use_id: string; content: string | null; is_error: boolean }): void {
    const blocks = messagesEl.querySelectorAll('.tool-block');
    let targetBlock: HTMLElement | null = null;
    let targetBody: Element | null = null;

    for (const block of blocks) {
        if ((block as HTMLElement).dataset.toolUseId === msg.tool_use_id) {
            targetBlock = block as HTMLElement;
            targetBody = block.querySelector('.tool-body-inner');
            break;
        }
    }

    if (!targetBody || !targetBlock) { return; }

    // Update status indicator
    const statusEl = targetBlock.querySelector('.tool-status');
    if (statusEl) {
        statusEl.className = 'tool-status ' + (msg.is_error ? 'error' : 'done');
        statusEl.textContent = msg.is_error ? 'Error' : 'Done';
    }

    const resultDiv = document.createElement('div');
    resultDiv.className = 'tool-result-block' + (msg.is_error ? ' error' : '');

    const label = document.createElement('div');
    label.className = 'result-label';
    label.textContent = msg.is_error ? 'Error' : 'Result';
    resultDiv.appendChild(label);

    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'result-content';

    const pre = document.createElement('pre');
    pre.textContent = msg.content ?? '';
    scrollContainer.appendChild(pre);

    resultDiv.appendChild(scrollContainer);
    targetBody.appendChild(resultDiv);

    // Auto-open on error
    if (msg.is_error) {
        const toolBody = targetBlock.querySelector('.tool-body');
        toolBody?.classList.add('open');
        const chevron = targetBlock.querySelector('.chevron');
        chevron?.classList.add('open');
    }
}

// ── Permission prompts ───────────────────────────────────────────────────────

function renderPermissionRequest(msg: {
    request_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    allowlist_suggestion?: { scope: string; match: string };
}): void {
    currentAssistantEl = null;
    finishThinking();

    const block = document.createElement('div');
    block.className = 'permission-block';
    block.dataset.requestId = msg.request_id;

    const header = document.createElement('div');
    header.className = 'permission-header';

    const label = document.createElement('span');
    label.className = 'permission-label';
    label.textContent = 'Permission requested';
    header.appendChild(label);

    const detail = document.createElement('div');
    detail.className = 'permission-detail';

    const toolLabel = document.createElement('span');
    toolLabel.className = 'permission-tool-name';
    toolLabel.textContent = msg.tool_name;

    const summaryText = document.createElement('span');
    summaryText.className = 'permission-summary';
    summaryText.textContent = getToolSummary(msg.tool_name, msg.tool_input);

    detail.appendChild(toolLabel);
    detail.appendChild(summaryText);

    const detailBody = document.createElement('details');
    detailBody.className = 'permission-input-details';
    const detailSummary = document.createElement('summary');
    detailSummary.textContent = 'Show details';
    detailBody.appendChild(detailSummary);
    const detailPre = document.createElement('pre');
    detailPre.textContent = JSON.stringify(msg.tool_input, null, 2);
    detailBody.appendChild(detailPre);

    const actions = document.createElement('div');
    actions.className = 'permission-actions';

    const allowBtn = document.createElement('button');
    allowBtn.className = 'permission-btn allow';
    allowBtn.textContent = 'Allow once';
    allowBtn.addEventListener('click', () => {
        respondToPermission(msg.request_id, true, false, block);
    });

    // "Always allow" button with a human-readable description of what'll be remembered
    const alwaysBtn = document.createElement('button');
    alwaysBtn.className = 'permission-btn allow always';
    const sug = msg.allowlist_suggestion;
    if (sug) {
        let labelText = 'Always allow';
        if (sug.scope === 'prefix' && sug.match) {
            labelText = `Always allow "${sug.match}*"`;
        } else if (sug.scope === 'dirtree' && sug.match) {
            const short = sug.match.split('/').slice(-2).join('/');
            labelText = `Always allow in .../${short}`;
        } else if (sug.scope === 'tool') {
            labelText = `Always allow ${msg.tool_name}`;
        }
        alwaysBtn.textContent = labelText;
        alwaysBtn.title = `Remembered as: ${sug.scope}=${sug.match}`;
    } else {
        alwaysBtn.textContent = 'Always allow';
    }
    alwaysBtn.addEventListener('click', () => {
        respondToPermission(msg.request_id, true, true, block);
    });

    const denyBtn = document.createElement('button');
    denyBtn.className = 'permission-btn deny';
    denyBtn.textContent = 'Deny';
    denyBtn.addEventListener('click', () => {
        respondToPermission(msg.request_id, false, false, block);
    });

    actions.appendChild(allowBtn);
    if (msg.allowlist_suggestion) {
        actions.appendChild(alwaysBtn);
    }
    actions.appendChild(denyBtn);

    block.appendChild(header);
    block.appendChild(detail);
    block.appendChild(detailBody);
    block.appendChild(actions);

    messagesEl.appendChild(block);
    scrollToBottom();
}

function respondToPermission(requestId: string, allow: boolean, remember: boolean, block: HTMLElement): void {
    vscode.postMessage({
        type: 'permission_response',
        request_id: requestId,
        allow,
        remember,
    });

    const actions = block.querySelector('.permission-actions');
    if (actions) {
        actions.innerHTML = '';
        const result = document.createElement('span');
        result.className = 'permission-result ' + (allow ? 'allowed' : 'denied');
        result.textContent = allow
            ? (remember ? 'Allowed (remembered)' : 'Allowed')
            : 'Denied';
        actions.appendChild(result);
    }
    block.classList.add('resolved');
}

// ── Thinking ─────────────────────────────────────────────────────────────────

function renderThinking(text: string): void {
    if (currentThinkingEl) {
        // Append to existing thinking block
        const content = currentThinkingEl.querySelector('.thinking-content')!;
        content.textContent = (content.textContent || '') + text;

        // Update the label preview
        updateThinkingPreview(currentThinkingEl, content.textContent || '');
        scrollToBottom();
        return;
    }

    // Create new thinking block using native <details>
    const block = document.createElement('details');
    block.className = 'thinking-block';

    const summary = document.createElement('summary');
    summary.className = 'thinking-summary active';
    summary.textContent = 'Thinking';
    block.appendChild(summary);

    const content = document.createElement('div');
    content.className = 'thinking-content';
    content.textContent = text;
    block.appendChild(content);

    messagesEl.appendChild(block);
    currentThinkingEl = block;
    scrollToBottom();
}

function updateThinkingPreview(block: HTMLElement, fullText: string): void {
    const summary = block.querySelector('.thinking-summary')!;
    const preview = fullText.replace(/\s+/g, ' ').trim();
    if (preview.length > 60) {
        summary.textContent = 'Thinking \u2014 ' + preview.substring(0, 60) + '\u2026';
    } else if (preview.length > 0) {
        summary.textContent = 'Thinking \u2014 ' + preview;
    }
}

function finishThinking(): void {
    if (!currentThinkingEl) { return; }

    const summary = currentThinkingEl.querySelector('.thinking-summary');
    if (summary) {
        summary.classList.remove('active');
        const content = currentThinkingEl.querySelector('.thinking-content');
        const fullText = content?.textContent || '';
        const preview = fullText.replace(/\s+/g, ' ').trim();
        if (preview.length > 80) {
            summary.textContent = 'Thought \u2014 ' + preview.substring(0, 80) + '\u2026';
        } else if (preview.length > 0) {
            summary.textContent = 'Thought \u2014 ' + preview;
        } else {
            summary.textContent = 'Thought';
        }
    }

    currentThinkingEl = null;
}

// ── Result info ──────────────────────────────────────────────────────────────

function renderResultInfo(msg: { duration_ms: number; total_cost_usd: number | null; num_turns: number }): void {
    const el = document.createElement('div');
    el.className = 'result-info';

    const cost = msg.total_cost_usd !== null ? '$' + msg.total_cost_usd.toFixed(4) : '\u2014';
    const turns = msg.num_turns + ' turn' + (msg.num_turns !== 1 ? 's' : '');
    const duration = (msg.duration_ms / 1000).toFixed(1) + 's';

    el.innerHTML =
        '<span>' + turns + '</span>' +
        '<span class="info-divider">\u00B7</span>' +
        '<span>' + duration + '</span>' +
        '<span class="info-divider">\u00B7</span>' +
        '<span>' + cost + '</span>';

    messagesEl.appendChild(el);
    scrollToBottom();
}

// ── Error ────────────────────────────────────────────────────────────────────

function appendError(text: string): void {
    const el = document.createElement('div');
    el.className = 'message assistant error-msg';

    const label = document.createElement('div');
    label.className = 'role-label error-label';
    label.textContent = 'Error';
    el.appendChild(label);

    const msgText = document.createElement('div');
    msgText.className = 'msg-text';
    msgText.textContent = text;
    el.appendChild(msgText);

    messagesEl.appendChild(el);
    scrollToBottom();
}

// ── Status ───────────────────────────────────────────────────────────────────

function renderStatus(status: string): void {
    const labels: Record<string, string> = {
        connected: 'Connected',
        connecting: 'Connecting\u2026',
        disconnected: 'Disconnected',
        error: 'Error',
    };
    statusEl.innerHTML = '<span class="dot ' + status + '"></span>' + (labels[status] || status);
}

// ── AskUserQuestion ──────────────────────────────────────────────────────────

function renderAskUserQuestion(
    toolId: string,
    question: string,
    options: Array<{ label: string; description?: string }> | null,
    multiSelect: boolean,
): void {
    currentAssistantEl = null;

    const container = document.createElement('div');
    container.className = 'ask-question-block';

    const qEl = document.createElement('div');
    qEl.className = 'ask-question-text';
    qEl.textContent = question;
    container.appendChild(qEl);

    if (options && options.length > 0) {
        const selected = new Set<string>();
        const optionsEl = document.createElement('div');
        optionsEl.className = 'ask-question-options';

        for (const opt of options) {
            const btn = document.createElement('button');
            btn.className = 'ask-option-btn';
            const labelSpan = document.createElement('span');
            labelSpan.className = 'ask-option-label';
            labelSpan.textContent = opt.label;
            btn.appendChild(labelSpan);
            if (opt.description) {
                const descSpan = document.createElement('span');
                descSpan.className = 'ask-option-desc';
                descSpan.textContent = opt.description;
                btn.appendChild(descSpan);
            }

            if (multiSelect) {
                btn.addEventListener('click', () => {
                    if (selected.has(opt.label)) {
                        selected.delete(opt.label);
                        btn.classList.remove('selected');
                    } else {
                        selected.add(opt.label);
                        btn.classList.add('selected');
                    }
                });
            } else {
                btn.addEventListener('click', () => {
                    // Disable all buttons, send answer
                    optionsEl.querySelectorAll('.ask-option-btn').forEach(b => {
                        (b as HTMLButtonElement).disabled = true;
                    });
                    btn.classList.add('selected');
                    container.classList.add('answered');
                    vscode.postMessage({ type: 'ask_user_answer', tool_id: toolId, answer: opt.label });
                });
            }
            optionsEl.appendChild(btn);
        }

        container.appendChild(optionsEl);

        // Always add a free-text input below options
        const freeRow = document.createElement('div');
        freeRow.className = 'ask-input-row';
        freeRow.style.marginTop = '8px';
        const freeInput = document.createElement('input');
        freeInput.type = 'text';
        freeInput.className = 'ask-input';
        freeInput.placeholder = 'Or type your own answer...';
        const freeSend = document.createElement('button');
        freeSend.className = 'ask-submit-btn';
        freeSend.textContent = 'Send';
        const freeSubmit = () => {
            const answer = freeInput.value.trim();
            if (!answer) return;
            freeInput.disabled = true;
            freeSend.disabled = true;
            optionsEl.querySelectorAll('.ask-option-btn').forEach(b => { (b as HTMLButtonElement).disabled = true; });
            container.classList.add('answered');
            vscode.postMessage({ type: 'ask_user_answer', tool_id: toolId, answer });
        };
        freeSend.addEventListener('click', freeSubmit);
        freeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') freeSubmit(); });
        freeRow.appendChild(freeInput);
        freeRow.appendChild(freeSend);
        container.appendChild(freeRow);

        if (multiSelect) {
            const submitBtn = document.createElement('button');
            submitBtn.className = 'ask-submit-btn';
            submitBtn.textContent = 'Submit';
            submitBtn.addEventListener('click', () => {
                const answer = Array.from(selected).join(', ') || '(no selection)';
                optionsEl.querySelectorAll('.ask-option-btn').forEach(b => {
                    (b as HTMLButtonElement).disabled = true;
                });
                submitBtn.disabled = true;
                container.classList.add('answered');
                vscode.postMessage({ type: 'ask_user_answer', tool_id: toolId, answer });
            });
            container.appendChild(submitBtn);
        }
    } else {
        // Free-form text input
        const inputRow = document.createElement('div');
        inputRow.className = 'ask-input-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ask-input';
        input.placeholder = 'Type your answer...';
        const sendBtn = document.createElement('button');
        sendBtn.className = 'ask-submit-btn';
        sendBtn.textContent = 'Send';

        const submit = () => {
            const answer = input.value.trim() || '(no answer)';
            input.disabled = true;
            sendBtn.disabled = true;
            container.classList.add('answered');
            vscode.postMessage({ type: 'ask_user_answer', tool_id: toolId, answer });
        };
        sendBtn.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { submit(); } });

        inputRow.appendChild(input);
        inputRow.appendChild(sendBtn);
        container.appendChild(inputRow);
        setTimeout(() => input.focus(), 50);
    }

    messagesEl.appendChild(container);
    scrollToBottom();
}

// ── Scroll ───────────────────────────────────────────────────────────────────

function scrollToBottom(): void {
    requestAnimationFrame(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    });
}

// ── Init ─────────────────────────────────────────────────────────────────────

vscode.postMessage({ type: 'ready' });
