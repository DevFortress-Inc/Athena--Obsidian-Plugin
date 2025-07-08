import { Plugin, Notice, TFile, CachedMetadata, Setting, App, Modal, requestUrl} from 'obsidian';

interface ScraperSettings {
	athenaUsername: string;
	athenaPassword: string;
	apiEndpoint: string;
	loginEndpoint: string;
	logoutEndpoint: string;
    isAuthenticated: boolean;
}

const DEFAULT_SETTINGS: ScraperSettings = {
	athenaUsername: "",
	athenaPassword: "",
	apiEndpoint: "https://meet-staging.devfortress.com/obsidianaddon/note-data",
    loginEndpoint: "https://meet-staging.devfortress.com/obsidianaddon/login",
    logoutEndpoint: "https://meet-staging.devfortress.com/obsidianaddon/logout",
    isAuthenticated: false
}

interface NoteData {
    // Basic data
    title: string;
    path: string;
    content: string;
    // Timestamps
    created: number;
    modified: number;
    //MetaData
    tags: string[];
    links: string[];
    headings: string[];
    frontmatter?: Record<string, unknown>;
}

// Matches with ss Arya sent
interface ApiPayload {
    user: string; // Take this out later
    title: string;
    content: string;
    path: string;
    created: string;
    modified: string;
    frontmatter: Record<string, unknown>;
    headings: Array<{text: string, level: number}>;
    links: Array<{text: string, link: string}>;
    tags: string[];
} 

// Auth response
interface AuthResponse {
    success: boolean;
    message?: string;
}



export default class NoteScraperPlugin extends Plugin {
    settings: ScraperSettings;
    
    // Store all scraped data here
    private allNotesData: NoteData[] = [];
   
    async onload(): Promise<void> {
        console.log("NoteScraperPlugin loaded");

        await this.loadSettings();

        const ribbonIconEl = this.addRibbonIcon('settings', 'Athena AI Settings', (evt: MouseEvent) => {
            // This adds a settings popup so the user can configure the credentials
            new SettingsModal(this.app, this).open();
        });
        ribbonIconEl.addClass('athena-scraper-ribbon-class');


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
        try {
            const authPayload = {
                email: username,
                password: password
            };

            const response = await requestUrl({
                url: "https://meet-staging.devfortress.com/obsidianaddon/login",
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(authPayload)
            });

            if (response.status === 200) {
                console.log('Successfully authenticated:', response.json);
                this.settings.isAuthenticated = true;
                await this.saveSettings();
                return true;
            } else {
                throw new Error(`Authentication failed with status ${response.status}`);
            }

        } catch (error) {
            console.error('❌ Invalid URL detected:', this.settings.loginEndpoint);
            console.error('Authentication failed:', error);
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
        if (!this.settings.athenaUsername) {
            new Notice("Username not configured! Please check settings.");
            return;
        }
        try {
        const payload: ApiPayload = {
                user: this.settings.athenaUsername,
                title: noteData.title,
                content: noteData.content,
                path: noteData.path,
                created: new Date(noteData.created).toISOString(),
                modified: new Date(noteData.modified).toISOString(),
                frontmatter: noteData.frontmatter || {},
                headings: noteData.headings.map(heading => ({
                    text: heading,
                    level: 1 // You might want to extract actual heading levels
                })),
                links: noteData.links.map(link => ({
                    text: link,
                    link: link
                })),
                tags: noteData.tags
            };

            // Make the API request using Obsidian's requestUrl
            const response = await requestUrl({
                url: this.settings.apiEndpoint,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload)
            });

            if (response.status === 200) {
                console.log('Successfully sent to API:', response.json);
            } else {
                throw new Error(`API responded with status ${response.status}`);
            }

        } catch (error) {
            console.error('Failed to send to API: ', error)
            throw error;
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