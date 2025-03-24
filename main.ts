import { App, Editor, MarkdownView, Plugin, PluginSettingTab, Setting, requestUrl, Notice, Modal } from 'obsidian';

interface YandexTrackerSettings {
    trackerBaseURL: string;
    apiToken: string;
    orgId: string;
    defaultDescription: string;
    defaultAssignees: string[];  // Array of assignee usernames
}

const DEFAULT_SETTINGS: YandexTrackerSettings = {
    trackerBaseURL: 'https://tracker.yandex.ru/',
    apiToken: '',
    orgId: '',
    defaultDescription: `{% cut "Создано из Obsidian" %}

Эта задача создана из заметок в Obsidian.

{% endcut %}`,
    defaultAssignees: []
}

interface TaskCreationData {
    confirmed: boolean;
    summary: string;
    description: string;
    deadline: string;
    tags: string[];
    assignee: string;
}

class ConfirmationModal extends Modal {
    private result: Promise<TaskCreationData>;
    private resolvePromise: (value: TaskCreationData) => void;
    private summaryInput: HTMLInputElement;
    private descriptionInput: HTMLTextAreaElement;
    private deadlineInput: HTMLInputElement;
    private tagsInput: HTMLInputElement;
    private assigneeInput: HTMLInputElement;

    constructor(app: App, private summary: string, private queueKey: string, private plugin: YandexTrackerLinkerPlugin) {
        super(app);
        this.result = new Promise((resolve) => {
            this.resolvePromise = resolve;
        });
    }

    onOpen() {
        const {contentEl} = this;
        contentEl.createEl("h2", { text: "Create Yandex Tracker Task?" });
        
        // Summary field
        const summaryContainer = contentEl.createDiv();
        summaryContainer.createEl("p", { text: "Summary:" });
        this.summaryInput = summaryContainer.createEl("input", {
            type: "text",
            value: this.summary
        });
        this.summaryInput.style.width = "100%";
        this.summaryInput.style.marginBottom = "1em";

        // Description field with text from settings
        const descriptionContainer = contentEl.createDiv();
        descriptionContainer.createEl("p", { text: "Description (markdown):" });
        this.descriptionInput = descriptionContainer.createEl("textarea");
        this.descriptionInput.value = this.plugin.settings.defaultDescription;
        this.descriptionInput.style.width = "100%";
        this.descriptionInput.style.height = "100px";
        this.descriptionInput.style.marginBottom = "1em";

        // Deadline field
        const deadlineContainer = contentEl.createDiv();
        deadlineContainer.createEl("p", { text: "Deadline:" });
        this.deadlineInput = deadlineContainer.createEl("input", {
            type: "date",
        });
        this.deadlineInput.style.width = "100%";
        this.deadlineInput.style.marginBottom = "1em";
        // Set default value to tomorrow
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        this.deadlineInput.value = tomorrow.toISOString().split('T')[0];

        // Tags field
        const tagsContainer = contentEl.createDiv();
        tagsContainer.createEl("p", { text: "Tags (comma-separated):" });
        this.tagsInput = tagsContainer.createEl("input", {
            type: "text",
            placeholder: "tag1, tag2, tag3"
        });
        this.tagsInput.style.width = "100%";
        this.tagsInput.style.marginBottom = "1em";

        // Updated Assignee field with quick-fill buttons from settings
        const assigneeContainer = contentEl.createDiv();
        assigneeContainer.createEl("p", { text: "Assignee:" });
        const assigneeWrapper = assigneeContainer.createDiv();
        assigneeWrapper.style.display = "flex";
        assigneeWrapper.style.gap = "10px";
        assigneeWrapper.style.marginBottom = "1em";

        this.assigneeInput = assigneeWrapper.createEl("input", {
            type: "text",
            placeholder: "Username"
        });
        this.assigneeInput.style.flex = "1";

        // Create quick-fill buttons for each default assignee
        for (const assignee of this.plugin.settings.defaultAssignees) {
            const assigneeButton = assigneeWrapper.createEl("button", { 
                text: assignee,
                cls: "mod-cta"
            });
            assigneeButton.onclick = () => {
                this.assigneeInput.value = assignee;
            };
        }

        // Queue info
        contentEl.createEl("p", { text: `Queue: ${this.queueKey}` });

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
        
        buttonContainer.createEl("button", { text: "Cancel" }).onclick = () => {
            this.resolvePromise({
                confirmed: false,
                summary: this.summary,
                description: "",
                deadline: "",
                tags: [],
                assignee: ""
            });
            this.close();
        };

        buttonContainer.createEl("button", { text: "Create", cls: "mod-cta" }).onclick = () => {
            this.resolvePromise({
                confirmed: true,
                summary: this.summaryInput.value.trim(),
                description: this.descriptionInput.value.trim(),
                deadline: this.deadlineInput.value,
                tags: this.tagsInput.value.split(',').map(tag => tag.trim()).filter(tag => tag),
                assignee: this.assigneeInput.value.trim()
            });
            this.close();
        };
    }

    onClose() {
        const {contentEl} = this;
        // Ensure promise is resolved when modal is closed by ESC key
        if (this.resolvePromise) {
            this.resolvePromise({
                confirmed: false,
                summary: this.summary,
                description: "",
                deadline: "",
                tags: [],
                assignee: ""
            });
        }
        contentEl.empty();
    }

    async getResult(): Promise<TaskCreationData> {
        return this.result;
    }
}

export default class YandexTrackerLinkerPlugin extends Plugin {
    settings: YandexTrackerSettings;
    private taskRegex = /@([A-Z]+-\d+)(?= )/g;  // For existing tasks
    private newTaskRegex = /(.*?)\s*@([A-Z]+)(?= )/; // Removed ^ to match anywhere in line
    private isProcessing = false;
    private linkRegex = /\[([A-Z]+-\d+)\]\(https?:\/\/[^\)]+\)/g;

    async onload() {
        await this.loadSettings();

        console.log("YandexTrackerLinkerPlugin loaded.");

        // Add command to convert tracker links
        this.addCommand({
            id: 'convert-tracker-links',
            name: 'Convert Tracker Links',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.processText(editor);
            }
        });

        // Listen for editor changes
        this.registerEvent(
            this.app.workspace.on('editor-change', (editor: Editor) => {
                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);
                const charBeforeCursor = cursor.ch > 0 ? line.charAt(cursor.ch - 1) : '';
                
                if (!this.isProcessing && charBeforeCursor === ' ') {
                    this.processText(editor);
                }
            })
        );

        // Add settings tab
        this.addSettingTab(new YandexTrackerSettingTab(this.app, this));
    }

    onunload() {
        console.log("YandexTrackerLinkerPlugin unloaded.");
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private async createTask(data: {
        summary: string,
        queueKey: string,
        description: string,
        deadline: string,
        tags: string[],
        assignee: string
    }): Promise<string> {
        try {
            const requestBody: any = {
                summary: data.summary,
                queue: {
                    key: data.queueKey
                },
                description: data.description,
                deadline: data.deadline ? new Date(data.deadline).toISOString() : undefined,
                tags: data.tags
            };

            // Only add assignee if it's not empty
            if (data.assignee) {
                requestBody.assignee = data.assignee;
            }

            const response = await requestUrl({
                url: 'https://api.tracker.yandex.net/v2/issues/',
                method: 'POST',
                headers: {
                    'Authorization': `OAuth ${this.settings.apiToken}`,
                    'X-Org-ID': this.settings.orgId,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody)
            });

            if (response.status !== 201) {
                throw new Error(`API request failed: ${response.status}`);
            }

            const responseData = Array.isArray(response.json) ? response.json[0] : response.json;

            if (!responseData || !responseData.key) {
                throw new Error('Invalid API response: missing task key');
            }

            return responseData.key;

        } catch (error) {
            console.error('Failed to create task:', error);
            if (error instanceof Error) {
                new Notice(`Failed to create task: ${error.message}`);
            }
            throw error;
        }
    }

    private cleanMarkdown(text: string): string {
        return text
            // Remove numbered lists (e.g., "1. ", "2. ")
            .replace(/^\d+\.\s+/, '')
            // Remove bullet points
            .replace(/^[-*+]\s+/, '')
            // Remove bold/italic markers
            .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
            // Remove code blocks
            .replace(/`([^`]+)`/g, '$1')
            // Remove links but keep text
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Remove blockquotes
            .replace(/^>\s+/, '')
            // Remove HTML tags
            .replace(/<[^>]+>/g, '')
            // Remove extra whitespace
            .trim();
    }

    private async processText(editor: Editor) {
        if (this.isProcessing) return;
        
        this.isProcessing = true;
        const cursor = editor.getCursor();
        const content = editor.getValue();
        let updatedContent = content;

        try {
            const lines = content.split('\n');
            const currentLine = lines[cursor.line];
            const newTaskMatch = this.newTaskRegex.exec(currentLine);

            if (newTaskMatch && !currentLine.includes('](')) {
                const [fullMatch, taskSummary, queueKey] = newTaskMatch;
                if (this.settings.apiToken && this.settings.orgId) {
                    try {
                        const cleanSummary = this.cleanMarkdown(taskSummary || "");
                        const summary = cleanSummary.trim() || "New task";

                        const modal = new ConfirmationModal(this.app, summary, queueKey, this);
                        modal.open();

                        const result = await modal.getResult();
                        if (!result.confirmed) {
                            this.isProcessing = false;
                            return;
                        }

                        const taskId = await this.createTask({
                            summary: result.summary,
                            queueKey: queueKey,
                            description: result.description,
                            deadline: result.deadline,
                            tags: result.tags,
                            assignee: result.assignee
                        });
                        const newLine = currentLine.replace(
                            fullMatch, 
                            `${taskSummary ? taskSummary + ' ' : ''}[${taskId}](${this.settings.trackerBaseURL}${taskId})`
                        );
                        lines[cursor.line] = newLine;
                        updatedContent = lines.join('\n');
                        
                        new Notice(`Task ${taskId} created successfully!`);
                    } catch (error) {
                        console.error('Failed to create task:', error);
                        this.isProcessing = false;
                        return;
                    }
                } else {
                    new Notice('Please configure API Token and Organization ID in settings');
                    this.isProcessing = false;
                    return;
                }
            }

            // Process existing task links
            updatedContent = updatedContent.replace(this.taskRegex, (fullMatch, taskId, offset) => {
                // Skip if we're already in a link
                if (content.slice(Math.max(0, offset - 3), offset).endsWith('](')) return fullMatch;
                
                // Get the current line
                const lines = content.split('\n');
                const currentLineIndex = content.slice(0, offset).split('\n').length - 1;
                const currentLine = lines[currentLineIndex];
                
                // Check if there's already a link to this task in the current line
                const urlPattern = new RegExp(`\\[${taskId}\\]\\(${this.settings.trackerBaseURL}${taskId}\\)`);
                if (urlPattern.test(currentLine)) return fullMatch;

                return `[${taskId}](${this.settings.trackerBaseURL}${taskId})`;
            });

            if (content !== updatedContent) {
                editor.setValue(updatedContent);
                editor.setCursor(cursor);
            }
        } finally {
            this.isProcessing = false;
        }
    }
}

class YandexTrackerSettingTab extends PluginSettingTab {
    plugin: YandexTrackerLinkerPlugin;

    constructor(app: App, plugin: YandexTrackerLinkerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Tracker Base URL')
            .setDesc('Base URL for Yandex Tracker')
            .addText(text => text
                .setPlaceholder('Enter base URL')
                .setValue(this.plugin.settings.trackerBaseURL)
                .onChange(async (value) => {
                    this.plugin.settings.trackerBaseURL = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('API Token')
            .setDesc('OAuth token for Yandex Tracker API')
            .addText(text => text
                .setPlaceholder('Enter API token')
                .setValue(this.plugin.settings.apiToken)
                .onChange(async (value) => {
                    this.plugin.settings.apiToken = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Organization ID')
            .setDesc('Your Yandex Tracker organization ID')
            .addText(text => text
                .setPlaceholder('Enter org ID')
                .setValue(this.plugin.settings.orgId)
                .onChange(async (value) => {
                    this.plugin.settings.orgId = value;
                    await this.plugin.saveSettings();
                }));

        // Add new settings
        new Setting(containerEl)
            .setName('Default Description')
            .setDesc('Default description template for new tasks')
            .addTextArea(text => text
                .setValue(this.plugin.settings.defaultDescription)
                .onChange(async (value) => {
                    this.plugin.settings.defaultDescription = value;
                    await this.plugin.saveSettings();
                }))
            .setClass("yandex-tracker-description-setting");

        new Setting(containerEl)
            .setName('Default Assignees')
            .setDesc('Comma-separated list of default assignee usernames for quick assignment')
            .addText(text => text
                .setPlaceholder('username1, username2, username3')
                .setValue(this.plugin.settings.defaultAssignees.join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.defaultAssignees = value.split(',')
                        .map(username => username.trim())
                        .filter(username => username.length > 0);
                    await this.plugin.saveSettings();
                }));

        // Add some CSS for the description textarea
        containerEl.createEl('style', {
            text: `
                .yandex-tracker-description-setting textarea {
                    width: 100%;
                    height: 100px;
                    font-family: monospace;
                }
            `
        });
    }
}