import { Plugin, Notice, TFile, CachedMetadata, Setting, App, Modal, requestUrl} from 'obsidian';

// Scrapes obsidian and sends the data to Athena AI
// const { google } = require('googleapis');
// const crypto = require('crypto');

// const oauth2Client = new google.auth.OAuth2(
//   "CLIENT_ID",
//   "CLIENT_SECRET",
//   "REDIRECT_URI e.g. http://localhost:3333/oauth2callback"
// );

interface ScraperSettings {
	athenaUsername: string;
	athenaPassword: string;
	apiEndpoint: string;
    // Refresh Token
    refresh?: string; 
}

const DEFAULT_SETTINGS: ScraperSettings = {
	athenaUsername: "",
	athenaPassword: "",
	apiEndpoint: "https://meet-staging.devfortress.com/obsidianaddon/note-data"
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
    // wordCount: number;
    // size: number;
}

// Matches with ss Arya sent
interface ApiPayload {
    user: string;
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
            console.error('Error scraping note', error);
             new Notice("Error scraping note.");
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


        console.log(noteData);
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

        // Login button
        const loginButton = contentEl.createEl('button', { text: 'Login' });
        loginButton.addClass('athena-login-button');
        loginButton.onclick = async () => {
            // Open the Google sign-in page
            startGoogleSignIn();
        };

        // Status indicator
        const statusEl = contentEl.createEl('div', { cls: 'athena-status' });
        if (this.plugin.settings.athenaUsername && this.plugin.settings.athenaPassword) {
            statusEl.createEl('p', { 
                text: '✅ Credentials saved', 
                cls: 'athena-status-success' 
            });
        } else {
            statusEl.createEl('p', { 
                text: '⚠️ Please enter your credentials for future use', 
                cls: 'athena-status-warning' 
            });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}



// Google Sign in | Temp until npm run dev works properly
import { exec } from 'child_process';
import { promisify } from 'util';

// Your Google OAuth credentials
const CLIENT_ID = '548017074101-l39k0b8p0v629ncha70g7p1l1do0hnos.apps.googleusercontent.com';
const CLIENT_SECRET = 'your-client-secret';

// What permissions you want from Google
const SCOPES = [
  // 'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email'
];


 // Build the Google OAuth URL
function buildGoogleAuthUrl(): string {
  // Where Google should send the user after they sign in
  const redirectUri = 'http://localhost:8080/callback';
  
  // Join all the scopes with spaces
  const scopeString = SCOPES.join(' ');
  
  // Build the URL parameters
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',  // We want an authorization code back
    scope: scopeString,
    access_type: 'offline', // So we get a refresh token
    prompt: 'consent'       // Force the consent screen
  });
  
  // The base Google OAuth URL + our parameters
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  
  return authUrl;
}

/**
 * Step 2: Open the user's browser to the Google sign-in page
 */
async function openBrowserToGoogle(url: string): Promise<void> {
  const execPromise = promisify(exec);
  
  let command: string;
  
  // Different command for different operating systems
  if (process.platform === 'darwin') {
    // macOS
    command = `open "${url}"`;
  } else if (process.platform === 'win32') {
    // Windows
    command = `start "" "${url}"`;
  } else {
    // Linux
    command = `xdg-open "${url}"`;
  }
  
  try {
    await execPromise(command);
    console.log('✅ Browser opened successfully!');
  } catch (error) {
    console.error('❌ Could not open browser automatically');
    console.log('Please manually copy and paste this URL into your browser:');
    console.log(url);
  }
}

/**
 * Main function - just opens Google sign-in
 */
async function startGoogleSignIn() {
  console.log('🚀 Starting Google OAuth...');
  
  // Step 1: Build the special Google URL
  const googleAuthUrl = buildGoogleAuthUrl();
  
  console.log('📝 Generated Google Auth URL:');
  console.log(googleAuthUrl);
  console.log('');
  
  // Step 2: Open browser to that URL
  console.log('🌐 Opening browser...');
  await openBrowserToGoogle(googleAuthUrl);
  
}

