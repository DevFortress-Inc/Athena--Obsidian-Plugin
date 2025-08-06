import { Plugin, Notice, TFile, CachedMetadata, Setting, App, Modal, requestUrl, ItemView, WorkspaceLeaf } from 'obsidian';

interface ScraperSettings {
    athenaUsername: string;
    athenaPassword: string;
    apiEndpoint: string;
    loginEndpoint: string;
    logoutEndpoint: string;
    isAuthenticated: boolean;
    authToken?: string;
}

const DEFAULT_SETTINGS: ScraperSettings = {
    athenaUsername: "",
    athenaPassword: "",
    apiEndpoint: "https://r2l0kbs4-3000.use.devtunnels.ms/obsidianaddon/note-data",
    loginEndpoint: "https://r2l0kbs4-3000.use.devtunnels.ms/obsidianaddon/login",
    logoutEndpoint: "https://r2l0kbs4-3000.use.devtunnels.ms/obsidianaddon/logout",
    isAuthenticated: false
};

interface NoteData {
    title: string;
    path: string;
    content: string;
    created: number;
    modified: number;
    tags: string[];
    links: string[];
    headings: string[];
    frontmatter?: Record<string, unknown>;
}

interface ApiPayload {
    title: string;
    content: string;
    path: string;
    created: string;
    modified: string;
    frontmatter: Record<string, unknown>;
    headings: Array<{ text: string; level: number }>;
    links: Array<{ text: string; link: string }>;
    tags: string[];
}

interface AuthResponse {
    success: boolean;
    message?: string;
}

const CHATBOT_VIEW_TYPE = "chatbot-view";

class ChatbotView extends ItemView {
    plugin: NoteScraperPlugin;

    constructor(leaf: WorkspaceLeaf, plugin: NoteScraperPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return CHATBOT_VIEW_TYPE;
    }

    getDisplayText(): string {
        return "Athena Chatbot";
    }

    async onOpen(): Promise<void> {
        console.log("ChatbotView onOpen called");
        const container = this.containerEl.children[1];
        console.log("Container element:", container);
        console.log("Container children:", this.containerEl.children);
        
        if (!container) {
            console.error("ChatbotView: Container not found");
            return;
        }
        
        container.empty();
        console.log("Container emptied");

        container.createEl("h2", { text: "Athena Chatbot" });
        console.log("Header created");

        const chatContainer = container.createDiv({ cls: "chat-container" });
        console.log("Chat container created");

        const chatLog = chatContainer.createEl("div", { cls: "chat-log" });
        const chatInput = chatContainer.createEl("textarea", { cls: "chat-input", placeholder: "Type your message..." });
        const sendButton = chatContainer.createEl("button", { text: "Send", cls: "chat-send-button" });
        console.log("Chat UI elements created");

        // Add Enter key support
        chatInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendButton.click();
            }
        });

        sendButton.onclick = async () => {
            const userMessage = chatInput.value.trim();
            if (!userMessage) return;

            const userMessageEl = chatLog.createEl("div", { cls: "chat-message user-message" });
            userMessageEl.textContent = userMessage;

            chatInput.value = "";

            const botMessageEl = chatLog.createEl("div", { cls: "chat-message bot-message" });
            botMessageEl.textContent = "Thinking...";

            try {
                const response = await this.plugin.getChatbotResponse(userMessage);
                botMessageEl.textContent = response;
            } catch (error) {
                botMessageEl.textContent = "Error: Unable to fetch response.";
                console.error(error);
            }
        };
        
        console.log("ChatbotView onOpen completed");
    }

    async onClose(): Promise<void> {
        // Cleanup if needed
    }
}

export default class NoteScraperPlugin extends Plugin {
    settings: ScraperSettings;
    private allNotesData: NoteData[] = [];

    async onload(): Promise<void> {
        console.log("NoteScraperPlugin loaded");

        await this.loadSettings();

        const ribbonIconEl = this.addRibbonIcon("settings", "Athena AI Settings", (evt: MouseEvent) => {
            new SettingsModal(this.app, this).open();
        });
        ribbonIconEl.addClass("athena-scraper-ribbon-class");

        console.log("Registering chatbot view type:", CHATBOT_VIEW_TYPE);
        this.registerView(CHATBOT_VIEW_TYPE, (leaf) => {
            console.log("Creating new ChatbotView instance");
            return new ChatbotView(leaf, this);
        });

        // Ensure the workspace is ready before adding the chatbot view
        this.app.workspace.onLayoutReady(() => {
            console.log("Workspace layout ready");
            if (!this.app.workspace.getLeavesOfType(CHATBOT_VIEW_TYPE).length) {
                const rightLeaf = this.app.workspace.getRightLeaf(false);
                if (rightLeaf) {
                    rightLeaf.setViewState({
                        type: CHATBOT_VIEW_TYPE,
                    });
                }
            }
        });

        this.addCommand({
            id: "toggle-chatbot-view",
            name: "Toggle Chatbot",
            callback: () => {
                console.log("Toggle Chatbot command executed");
                const leaves = this.app.workspace.getLeavesOfType(CHATBOT_VIEW_TYPE);
                console.log("Existing leaves:", leaves);

                if (leaves.length) {
                    // If the view exists, just activate it
                    const leaf = leaves[0];
                    if (leaf.view instanceof ChatbotView) {
                        this.app.workspace.setActiveLeaf(leaf, true, true);
                        console.log("Activated existing chatbot view");
                    } else {
                        // If it's not the right view type, replace it
                        leaf.setViewState({
                            type: CHATBOT_VIEW_TYPE,
                            active: true,
                        });
                        console.log("Replaced view with chatbot");
                    }
                } else {
                    console.log("Creating new chatbot view");
                    const rightLeaf = this.app.workspace.getRightLeaf(true);
                    if (rightLeaf) {
                        rightLeaf.setViewState({
                            type: CHATBOT_VIEW_TYPE,
                            active: true,
                        });
                        this.app.workspace.setActiveLeaf(rightLeaf, true, true);
                        console.log("Chatbot view created and activated");
                    } else {
                        console.error("Failed to get right leaf");
                        new Notice("Failed to create chatbot view");
                    }
                }
            },
        });

        this.addCommand({
            id: "close-chatbot-view",
            name: "Close Chatbot",
            callback: () => {
                const leaves = this.app.workspace.getLeavesOfType(CHATBOT_VIEW_TYPE);
                if (leaves.length) {
                    leaves[0].detach();
                    console.log("Chatbot view closed");
                }
            },
        });

        // *Original Scrape Functionality* Add this command to the command palette
        this.addCommand({
            id: 'scrape-current-note',
            name: 'Scrape',
            callback: async () => { // callback function is used because scraping a file takes time. We pause operations via the async keyword and call back the results of the scrape method once it is done scraping.
                await this.scrapeCurrentNote();
                new Notice("Test Note scraped successfully!");
            }
        });
    }

    onunload(): void {
        console.log("NoteScraperPlugin unloaded");
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    // Simple authentication method - mirrors sendToAPI pattern
    async authenticate(username: string, password: string): Promise<boolean> {
        console.log('🔌 [plugin] calling /login with', { username, password: '••••' });
        try {
            const resp = await requestUrl({
                url:     this.settings.loginEndpoint,
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ email: username, password })
            });
            console.log('🔌 [plugin] /login responded', resp.status, resp.text);
                const data = JSON.parse(resp.text);
                if (resp.status === 200 && data.token) {
                this.settings.authToken        = data.token;
                this.settings.isAuthenticated  = true;
                await this.saveSettings();
                return true;
                }
                console.error('Auth failed:', data);
                this.settings.isAuthenticated = false;
                await this.saveSettings();
                return false;
        } catch (e) {
            console.error('Auth error:', e);
            this.settings.isAuthenticated = false;
            await this.saveSettings();
            return false;
        }
        }

    private async scrapeCurrentNote(): Promise<void> {
        const file = this.app.workspace.getActiveFile();
       
        // If no file selected
        if (!file) {
            return;
        }

        try {
            const noteData = await this.extractNoteData(file);

            // Update or add to the data store
            const existingIndex = this.allNotesData.findIndex(note => note.path === file.path); // It paths are the same, update existing (as it returns the index of the existing note). If not, add new to array.
            if (existingIndex !== -1) {
                this.allNotesData[existingIndex] = noteData; // Update existing. We take the index given to us, and replace that note with the new noteData
            } else {
                this.allNotesData.push(noteData); // Add new to our array of all scraped notes
            }

            await this.sendToAPI(noteData);

            new Notice("Note scraped and sent to Athena!");
        } catch (error) {
            console.error('❌ Invalid URL detected:', this.settings.apiEndpoint);
            console.error('Error sending note', error);
            new Notice("Error sending note.");
        }
    }

    // API endpoint sender
private async sendToAPI(noteData: NoteData): Promise<void> {
  if (!this.settings.authToken) {
    new Notice("Not logged in—please login first.");
    return;
  }
      const payload: ApiPayload = {
        title:       noteData.title,
        content:     noteData.content,
        path:        noteData.path,
        created:     new Date(noteData.created).toISOString(),
        modified:    new Date(noteData.modified).toISOString(),
        frontmatter: noteData.frontmatter || {},
        headings:    noteData.headings.map(text => ({ text, level: 1 })),
        links:       noteData.links.map(link => ({ text: link, link })),
        tags:        noteData.tags,
    };

  try {
console.log('🔌 [plugin] sending /note-data, token=', this.settings.authToken);
const resp = await requestUrl({
  url:     this.settings.apiEndpoint,
  method:  'POST',
  headers: {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${this.settings.authToken}`,
  },
  body:    JSON.stringify(payload)
});
console.log('🔌 [plugin] /note-data responded', resp.status, resp.text);
    if (resp.status === 200) {
      new Notice("✅ Note sent!");
    } else {
      throw new Error(`API ${resp.status}: ${resp.text}`);
    }
  } catch (e) {
    console.error('Send error:', e);
    new Notice("❌ Failed to send note.");
    throw e;
  }
}
    // Helper function to extract note data from a file
    private async extractNoteData(file: TFile): Promise<NoteData> {
        // Get file content
        const content = await this.app.vault.read(file);

        // Get metadata
        const metadata: CachedMetadata | null = this.app.metadataCache.getFileCache(file); // There may be some metadata we do not need that we do not assign to anything ***

        // Extract frontmatter (title, author, tags etc.)
        const frontmatter = metadata?.frontmatter || {};

        // Extract tags
        const tags: string[] = [];
        if (metadata?.tags) {
            tags.push(...metadata.tags.map(tag => tag.tag));
        }

        if (frontmatter.tags) {
            const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags]; // Either add to an array or make it the only value
            tags.push(...fmTags);
        }

        // Extract links
        const links: string[] = [];
        if (metadata?.links) {
            links.push(...metadata.links.map(link => link.link));
        }

        // Extract headings
        const headings: string[] = [];
        if (metadata?.headings) {
            headings.push(...metadata.headings.map(heading => heading.heading));
        }

        const noteData: NoteData = {
            title: file.basename,           // "MyNote" (filename without .md)
            path: file.path,               // "folder/MyNote.md"
            content: content,              // Full text content
            created: file.stat.ctime,      // Creation timestamp
            modified: file.stat.mtime,     // Last modified timestamp
            frontmatter: frontmatter,      // YAML metadata
            tags: [...new Set(tags)],      // Unique tags only (removes duplicates)
            links: links,                  // All linked notes/URLs
            headings: headings,            // All headings
            // wordCount: content.split(/\s+/).length,  // Count words
            // size: file.stat.size          // File size in bytes
        };

        console.log('Extracted note data:', noteData);
		return noteData
    }

    async getChatbotResponse(message: string): Promise<string> {
        try {
            const response = await requestUrl({
                url: this.settings.apiEndpoint + "/chatbot",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.settings.authToken}`,
                },
                body: JSON.stringify({ message }),
            });

            if (response.status === 200) {
                const data = JSON.parse(response.text);
                return data.reply || "No response.";
            } else {
                throw new Error(`API Error: ${response.status}`);
            }
        } catch (error) {
            console.error("Chatbot API error:", error);
            return "Error: Unable to fetch response.";
        }
    }
}

// Add this class after your main plugin class
class SettingsModal extends Modal {
    plugin: NoteScraperPlugin;

    constructor(app: App, plugin_: NoteScraperPlugin) {
        super(app);
        this.plugin = plugin_;
    }

    onOpen() {
        const { contentEl } = this;
        
        contentEl.empty(); // Clear any existing content

        contentEl.createEl('h2', { text: 'Athena AI Settings' });

        contentEl.createEl('p', {
            text: 'Configure your Athena Ai credentials here.'
        });
        
        // Username setting
        new Setting(contentEl)
            .setName('Username')
            .setDesc('Enter your Athena AI email or ID')
            .addText(text => text
                .setPlaceholder('Enter your email or ID')
                .setValue(this.plugin.settings.athenaUsername)
                .onChange(async (value) => {
                    this.plugin.settings.athenaUsername = value;
                    await this.plugin.saveSettings();
                }));

        // Password setting
        new Setting(contentEl)
            .setName('Password')
            .setDesc('Enter your Athena AI password')
            .addText(text => {
                text.setPlaceholder('Enter your password')
                    .setValue(this.plugin.settings.athenaPassword)
                    .onChange(async (value) => {
                        this.plugin.settings.athenaPassword = value;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.type = 'password';
                return text;
            });


        // Add Login Button
        const loginButton = contentEl.createEl('button', { text: 'Login' });
        loginButton.addClass('athena-login-button');
        loginButton.onclick = async () => {
            if (!this.plugin.settings.athenaUsername || !this.plugin.settings.athenaPassword) {
                new Notice('Please enter both username and password.');
                return;
            }

            try {
                // Example login logic (replace with actual API call if needed)
                const success = await this.plugin.authenticate(
                    this.plugin.settings.athenaUsername,
                    this.plugin.settings.athenaPassword
                );

                if (success) {
                    new Notice('Login successful!');
                    this.onOpen() // Refresh modal
                } else {
                    new Notice ('Login failed, please check your credentials');
                }
            } catch (error) {
                console.error('Login error:', error);
                new Notice('Login failed. Something is wrong');
            }
        };

        // Status indicator
        const statusEl = contentEl.createEl('div', { cls: 'athena-status' });
        if (this.plugin.settings.isAuthenticated) {
            statusEl.createEl('p', { 
                text: '✅ Authenticated and ready to scrape!', 
                cls: 'athena-status-success' 
            });
        } else if (this.plugin.settings.athenaUsername && this.plugin.settings.athenaPassword) {
            statusEl.createEl('p', { 
                text: '⚠️ Credentials saved but not authenticated. Please login.', 
                cls: 'athena-status-warning' 
            });
        } else {
            statusEl.createEl('p', { 
                text: '❌ Please enter your credentials and login', 
                cls: 'athena-status-error' 
            });
        }
    }



    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}