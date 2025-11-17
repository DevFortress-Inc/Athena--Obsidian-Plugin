import {
	Plugin,
	Notice,
	TFile,
	CachedMetadata,
	Setting,
	App,
	Modal,
	requestUrl,
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	Component,
} from "obsidian";

interface ScraperSettings {
	athenaUsername: string;
	athenaPassword: string;
	apiEndpoint: string;
	loginEndpoint: string;
	logoutEndpoint: string;
	isAuthenticated: boolean;
	authToken?: string;
	autoScrapingEnabled: boolean; // NEW: Auto-scraping toggle
	autoScrapeDelay: number; // NEW: Configurable delay
}

const DEFAULT_SETTINGS: ScraperSettings = {
	athenaUsername: "",
	athenaPassword: "",
	// need to be updated with the correct ngrok URLs
	apiEndpoint: "https://43ca4b8b34d3.ngrok-free.app/obsidianaddon/note-data",
	loginEndpoint: "https://43ca4b8b34d3.ngrok-free.app/obsidianaddon/login",
	logoutEndpoint: "https://43ca4b8b34d3.ngrok-free.app/obsidianaddon/logout",
	isAuthenticated: false,
	autoScrapingEnabled: true, // NEW: Default enabled
	autoScrapeDelay: 3000, // NEW: 3 second delay
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
	token?: string;
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
		await this.refreshView();
	}

	// NEW: Public method to refresh the view
	async refreshView(): Promise<void> {
		const container = this.containerEl.children[1];

		if (!container) {
			console.error("ChatbotView: Container not found");
			return;
		}

		container.empty();

		// Add Athena logo and title
		const headerDiv = container.createDiv({ cls: "athena-chatbot-header" });
		headerDiv.style.cssText =
			"display: flex; align-items: center; gap: 12px; margin-bottom: 8px; position: relative;";
		const logoImg = headerDiv.createEl("img", {
			attr: {
				src: "https://athenachat.bot/assets/athena/logo.png",
				alt: "Athena Logo",
			},
			cls: "athena-logo-img",
		});
		logoImg.style.cssText =
			"height: 32px; width: 32px; object-fit: contain;";
		headerDiv.createEl("h2", {
			text: "Athena Chatbot",
			cls: "athena-chatbot-title",
		});

		// Small autoscraping status alert on the right
		const autoScrapeAlert = headerDiv.createDiv({
			cls: "athena-autoscrape-alert",
		});
		autoScrapeAlert.style.cssText = `
            position: absolute;
            right: 0;
            top: 50%;
            transform: translateY(-50%);
            background: ${
				this.plugin.settings.autoScrapingEnabled
					? "var(--background-modifier-success)"
					: "var(--background-modifier-error)"
			};
            color: var(--text-normal);
            padding: 2px 10px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 500;
            box-shadow: 0 1px 4px rgba(0,0,0,0.04);
            margin-left: 12px;
        `;
		autoScrapeAlert.textContent = this.plugin.settings.autoScrapingEnabled
			? "Auto-scraping ON"
			: "Auto-scraping OFF";

		// Check if authenticated
		if (!this.plugin.settings.isAuthenticated) {
			container.createEl("h2", { text: "Athena Chatbot" });
			container.createEl("p", {
				text: "Please login first through the Athena AI Settings.",
			});

			const settingsButton = container.createEl("button", {
				text: "Open Settings",
				cls: "chat-settings-button",
			});
			settingsButton.onclick = () => {
				new SettingsModal(this.app, this.plugin).open();
			};
			return;
		}

		const chatContainer = container.createDiv({ cls: "chat-container" });
		const chatLog = chatContainer.createEl("div", { cls: "chat-log" });
		const inputContainer = chatContainer.createDiv({
			cls: "chat-input-container",
		});
		const chatInput = inputContainer.createEl("textarea", {
			cls: "chat-input",
			placeholder: "Ask Athena about your notes...",
		});
		const sendButton = inputContainer.createEl("button", {
			text: "Send",
			cls: "chat-send-button",
		});

		// Add some basic styling
		chatContainer.style.cssText = `
            display: flex; 
            flex-direction: column; 
            height: calc(100% - 100px); 
            padding: 10px;
        `;
		chatLog.style.cssText = `
            flex: 1; 
            overflow-y: auto; 
            border: 1px solid var(--background-modifier-border); 
            border-radius: 8px; 
            padding: 10px; 
            margin-bottom: 10px;
            background: var(--background-primary-alt);
        `;
		inputContainer.style.cssText = `
            display: flex; 
            gap: 8px;
        `;
		chatInput.style.cssText = `
            flex: 1; 
            resize: vertical; 
            min-height: 60px; 
            padding: 8px; 
            border-radius: 4px;
            border: 1px solid var(--background-modifier-border);
        `;
		sendButton.style.cssText = `
            padding: 8px 16px; 
            border-radius: 4px; 
            background: var(--interactive-accent); 
            color: var(--text-on-accent); 
            border: none; 
            cursor: pointer;
        `;

		// Add Enter key support
		chatInput.addEventListener("keydown", async (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				sendButton.click();
			}
		});

		sendButton.onclick = async () => {
			const userMessage = chatInput.value.trim();
			if (!userMessage) return;

			// Add user message to chat
			const userMessageEl = chatLog.createEl("div", {
				cls: "chat-message user-message",
			});
			userMessageEl.style.cssText = `
                margin-bottom: 10px; 
                padding: 8px 12px; 
                background: var(--interactive-accent); 
                color: var(--text-on-accent); 
                border-radius: 12px; 
                max-width: 80%; 
                margin-left: auto; 
                word-wrap: break-word;
            `;
			userMessageEl.textContent = userMessage;

			chatInput.value = "";

			// Add bot thinking message
			const botMessageEl = chatLog.createEl("div", {
				cls: "chat-message bot-message",
			});
			botMessageEl.style.cssText = `
                margin-bottom: 10px; 
                padding: 8px 12px; 
                background: var(--background-secondary); 
                border-radius: 12px; 
                max-width: 80%; 
                margin-right: auto; 
                word-wrap: break-word;
            `;
			botMessageEl.textContent = "Thinking...";

			// Scroll to bottom
			chatLog.scrollTop = chatLog.scrollHeight;

			try {
				const response = await this.plugin.getChatbotResponse(
					userMessage
				);

				// Clear placeholder
				botMessageEl.textContent = "";

				// Create a component for proper cleanup
				const component = new Component();

				try {
					// Use Obsidian's MarkdownRenderer properly
					await MarkdownRenderer.renderMarkdown(
						response,
						botMessageEl,
						"", // source path
						component
					);

					// Load the component to make interactive elements work
					component.load();
				} catch (mdError) {
					console.warn(
						"MarkdownRenderer failed, using fallback:",
						mdError
					);
					// Fallback to basic HTML parsing
					botMessageEl.innerHTML = this.parseBasicMarkdown(response);
				}
			} catch (error) {
				botMessageEl.textContent = "Error: Unable to fetch response.";
				console.error(error);
			}

			// Scroll to bottom again
			chatLog.scrollTop = chatLog.scrollHeight;
		};

		// After chatContainer and its children are created
		// Add Athena Chatbot footer branding
		const footerDiv = container.createDiv({ cls: "athena-chatbot-footer" });
		footerDiv.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin-top: 18px;
    padding: 8px 0;
    border-top: 1px solid var(--background-modifier-border);
    background: none;
`;
		const footerLogo = footerDiv.createEl("img", {
			attr: {
				src: "https://athenachat.bot/assets/athena/logo.png",
				alt: "Athena Logo",
			},
			cls: "athena-footer-logo",
		});
		footerLogo.style.cssText =
			"height: 24px; width: 24px; object-fit: contain;";
		const footerText = footerDiv.createEl("a", {
			text: "Athena Chatbot",
			href: "https://athenachat.bot/chatbot",
			cls: "athena-footer-link",
		});
		footerText.style.cssText = `
    color: #6014e3ff;
    font-weight: bold;
    font-size: 16px;
    text-decoration: none;
    transition: color 0.2s;
`;
		footerText.onmouseover = () => {
			footerText.style.color = "#a78bfa";
		};
		footerText.onmouseout = () => {
			footerText.style.color = "#7c3aed";
		};
		const learnMoreBtn = footerDiv.createEl("a", {
			text: "Learn more",
			href: "https://athenachat.bot/chatbot",
			cls: "athena-learnmore-btn",
		});
		learnMoreBtn.style.cssText = `
    margin-left: 10px;
    padding: 4px 14px;
    background: #7c3aed;
    color: #fff;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    text-decoration: none;
    box-shadow: 0 1px 4px rgba(124, 58, 237, 0.08);
    transition: background 0.2s;
`;
		learnMoreBtn.onmouseover = () => {
			learnMoreBtn.style.background = "#a78bfa";
		};
		learnMoreBtn.onmouseout = () => {
			learnMoreBtn.style.background = "#7c3aed";
		};
	}

	// Add this helper method for fallback markdown parsing
	parseBasicMarkdown(text: string): string {
		return (
			text
				// Bold text
				.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
				.replace(/__(.*?)__/g, "<strong>$1</strong>")

				// Italic text
				.replace(/\*(.*?)\*/g, "<em>$1</em>")
				.replace(/_(.*?)_/g, "<em>$1</em>")

				// Inline code
				.replace(/`(.*?)`/g, "<code>$1</code>")

				// Line breaks
				.replace(/\n/g, "<br>")

				// Links
				.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

				// Headers (simple version)
				.replace(/^### (.*$)/gm, "<h3>$1</h3>")
				.replace(/^## (.*$)/gm, "<h2>$1</h2>")
				.replace(/^# (.*$)/gm, "<h1>$1</h1>")

				// Blockquotes
				.replace(/^> (.*$)/gm, "<blockquote>$1</blockquote>")
		);
	}

	async onClose(): Promise<void> {
		// Cleanup if needed
	}
}

export default class NoteScraperPlugin extends Plugin {
	// Fetch user's notes from backend API for chatbot context
	private async fetchUserNotesFromAPI(): Promise<string> {
		if (!this.settings.authToken || !this.settings.isAuthenticated) {
			return "";
		}
		try {
			const baseUrl = this.settings.apiEndpoint.replace(
				"/obsidianaddon/note-data",
				""
			);
			const notesUrl = `${baseUrl}/obsidianaddon/user-notes`;
			console.log("🔍 Full URL being called:", notesUrl);
			console.log("🔍 Base URL:", baseUrl);
			console.log("🔍 Original endpoint:", this.settings.apiEndpoint);
			const response = await requestUrl({
				url: notesUrl,
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.settings.authToken}`,
					"Content-Type": "application/json",
					"ngrok-skip-browser-warning": "true",
				},
			});

			console.log("📡 Response status:", response.status);
			console.log(
				"📄 Response text (first 200 chars):",
				response.text.substring(0, 200)
			);

			if (response.status === 200) {
				const notes = JSON.parse(response.text);
				let context = "\n\n--- Your Recent Notes Context ---\n";

				notes.slice(0, 5).forEach((note: any) => {
					context += `Title: ${
						note.title
					}\nContent: ${note.content.substring(0, 500)}${
						note.content.length > 500 ? "..." : ""
					}\nTags: ${note.tags?.join(", ") || "None"}\n\n`;
				});

				return context + "--- End of Notes Context ---\n\n";
			} else {
				console.error(
					"❌ Non-200 response:",
					response.status,
					response.text
				);
				return "";
			}
		} catch (error) {
			console.error("❌ Failed to fetch notes from API:", error);
			console.error("Error details:", error.message);
			return "";
		}
	}

	settings: ScraperSettings;
	private allNotesData: NoteData[] = [];
	private conversationId: string;
	private autoScrapeTimeout: NodeJS.Timeout; // NEW: Auto-scrape timeout

	async onload(): Promise<void> {
		console.log("NoteScraperPlugin loaded");

		await this.loadSettings();

		const ribbonIconEl = this.addRibbonIcon(
			"settings",
			"Athena AI Settings",
			(evt: MouseEvent) => {
				new SettingsModal(this.app, this).open();
			}
		);
		ribbonIconEl.addClass("athena-scraper-ribbon-class");

		this.registerView(CHATBOT_VIEW_TYPE, (leaf) => {
			return new ChatbotView(leaf, this);
		});

		// Ensure the workspace is ready before adding the chatbot view
		this.app.workspace.onLayoutReady(() => {
			if (!this.app.workspace.getLeavesOfType(CHATBOT_VIEW_TYPE).length) {
				const rightLeaf = this.app.workspace.getRightLeaf(false);
				if (rightLeaf) {
					rightLeaf.setViewState({
						type: CHATBOT_VIEW_TYPE,
					});
				}
			}
		});

		// NEW: AUTO-SCRAPING - Listen for file modifications
		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				if (
					file instanceof TFile &&
					file.extension === "md" &&
					this.settings.autoScrapingEnabled &&
					this.settings.isAuthenticated
				) {
					// Debounce to avoid spamming API while user is typing
					clearTimeout(this.autoScrapeTimeout);
					this.autoScrapeTimeout = setTimeout(async () => {
						await this.autoScrapeNote(file);
					}, this.settings.autoScrapeDelay);
				}
			})
		);

		// NEW: Also listen for file creation
		this.registerEvent(
			this.app.vault.on("create", async (file) => {
				if (
					file instanceof TFile &&
					file.extension === "md" &&
					this.settings.autoScrapingEnabled &&
					this.settings.isAuthenticated
				) {
					// Small delay to let Obsidian finish creating the file
					setTimeout(async () => {
						await this.autoScrapeNote(file);
					}, 1000);
				}
			})
		);

		this.addCommand({
			id: "toggle-chatbot-view",
			name: "Toggle Chatbot",
			callback: () => {
				const leaves =
					this.app.workspace.getLeavesOfType(CHATBOT_VIEW_TYPE);

				if (leaves.length) {
					const leaf = leaves[0];
					if (leaf.view instanceof ChatbotView) {
						this.app.workspace.setActiveLeaf(leaf, true, true);
					} else {
						leaf.setViewState({
							type: CHATBOT_VIEW_TYPE,
							active: true,
						});
					}
				} else {
					const rightLeaf = this.app.workspace.getRightLeaf(true);
					if (rightLeaf) {
						rightLeaf.setViewState({
							type: CHATBOT_VIEW_TYPE,
							active: true,
						});
						this.app.workspace.setActiveLeaf(rightLeaf, true, true);
					}
				}
			},
		});

		this.addCommand({
			id: "close-chatbot-view",
			name: "Close Chatbot",
			callback: () => {
				const leaves =
					this.app.workspace.getLeavesOfType(CHATBOT_VIEW_TYPE);
				if (leaves.length) {
					leaves[0].detach();
				}
			},
		});

		this.addCommand({
			id: "scrape-current-note",
			name: "Scrape Current Note",
			callback: async () => {
				await this.scrapeCurrentNote();
			},
		});

		// NEW: Command to toggle auto-scraping
		this.addCommand({
			id: "toggle-auto-scraping",
			name: "Toggle Auto-Scraping",
			callback: async () => {
				this.settings.autoScrapingEnabled =
					!this.settings.autoScrapingEnabled;
				await this.saveSettings();
				new Notice(
					`Auto-scraping ${
						this.settings.autoScrapingEnabled
							? "enabled"
							: "disabled"
					}`
				);

				// Refresh chatbot view to update status
				const leaves =
					this.app.workspace.getLeavesOfType(CHATBOT_VIEW_TYPE);
				if (leaves.length && leaves[0].view instanceof ChatbotView) {
					await leaves[0].view.refreshView();
				}
			},
		});
	}

	onunload(): void {
		// NEW: Clear any pending auto-scrape timeouts
		if (this.autoScrapeTimeout) {
			clearTimeout(this.autoScrapeTimeout);
		}
		console.log("NoteScraperPlugin unloaded");
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async authenticate(username: string, password: string): Promise<boolean> {
		console.log("🔌 [plugin] calling /login with", {
			username,
			password: "••••",
		});
		try {
			const resp = await requestUrl({
				url: this.settings.loginEndpoint,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: username, password }),
			});

			console.log("🔌 [plugin] /login responded", resp.status, resp.text);

			if (resp.status === 200) {
				const data = JSON.parse(resp.text);

				// Check if token is in response, otherwise extract from cookies if needed
				if (data.token) {
					this.settings.authToken = data.token;
				} else {
					// If token not in response, we might need to handle cookie-based auth differently
					// For now, we'll assume the backend will be updated to return the token
					console.warn(
						"No token in response - you may need to update the backend to return the token"
					);
					return false;
				}

				this.settings.isAuthenticated = true;
				await this.saveSettings();
				return true;
			}

			this.settings.isAuthenticated = false;
			await this.saveSettings();
			return false;
		} catch (e) {
			console.error("Auth error:", e);
			this.settings.isAuthenticated = false;
			await this.saveSettings();
			return false;
		}
	}

	private async scrapeCurrentNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();

		if (!file) {
			new Notice("No file selected");
			return;
		}

		try {
			const noteData = await this.extractNoteData(file);

			const existingIndex = this.allNotesData.findIndex(
				(note) => note.path === file.path
			);
			if (existingIndex !== -1) {
				this.allNotesData[existingIndex] = noteData;
			} else {
				this.allNotesData.push(noteData);
			}

			await this.sendToAPI(noteData);
			new Notice("Note scraped and sent to Athena!");
		} catch (error) {
			console.error("Error sending note", error);
			new Notice("Error sending note.");
		}
	}

	// NEW: Auto-scraping method
	private async autoScrapeNote(file: TFile): Promise<void> {
		try {
			console.log(`🔄 Auto-scraping: ${file.path}`);

			// Check if user is authenticated before proceeding
			if (!this.settings.isAuthenticated || !this.settings.authToken) {
				console.log("⚠️ Auto-scrape skipped: User not authenticated");
				return;
			}

			const noteData = await this.extractNoteData(file);

			// Update local cache
			const existingIndex = this.allNotesData.findIndex(
				(note) => note.path === file.path
			);
			if (existingIndex !== -1) {
				this.allNotesData[existingIndex] = noteData;
			} else {
				this.allNotesData.push(noteData);
			}

			// Send to your database
			await this.sendToAPI(noteData);

			console.log(`✅ Auto-scraped: ${file.basename}`);
		} catch (error) {
			console.error("Auto-scrape error:", error);

			// Handle auth errors specifically
			if (
				error.message?.includes("401") ||
				error.message?.includes("Unauthorized")
			) {
				this.settings.isAuthenticated = false;
				await this.saveSettings();
				new Notice("Authentication expired. Please login again.");
			}
		}
	}

	private async sendToAPI(noteData: NoteData): Promise<void> {
		if (!this.settings.authToken) {
			new Notice("Not logged in—please login first.");
			return;
		}

		const payload: ApiPayload = {
			title: noteData.title,
			content: noteData.content,
			path: noteData.path,
			created: new Date(noteData.created).toISOString(),
			modified: new Date(noteData.modified).toISOString(),
			frontmatter: noteData.frontmatter || {},
			headings: noteData.headings.map((text) => ({ text, level: 1 })),
			links: noteData.links.map((link) => ({ text: link, link })),
			tags: noteData.tags,
		};

		try {
			const resp = await requestUrl({
				url: this.settings.apiEndpoint,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.settings.authToken}`,
				},
				body: JSON.stringify(payload),
			});

			if (resp.status === 200) {
				console.log("✅ Note sent successfully");
			} else {
				throw new Error(`API ${resp.status}: ${resp.text}`);
			}
		} catch (e) {
			console.error("Send error:", e);
			new Notice("❌ Failed to send note.");
			throw e;
		}
	}

	private async extractNoteData(file: TFile): Promise<NoteData> {
		const content = await this.app.vault.read(file);
		const metadata: CachedMetadata | null =
			this.app.metadataCache.getFileCache(file);

		const frontmatter = metadata?.frontmatter || {};

		const tags: string[] = [];
		if (metadata?.tags) {
			tags.push(...metadata.tags.map((tag) => tag.tag));
		}
		if (frontmatter.tags) {
			const fmTags = Array.isArray(frontmatter.tags)
				? frontmatter.tags
				: [frontmatter.tags];
			tags.push(...fmTags);
		}

		const links: string[] = [];
		if (metadata?.links) {
			links.push(...metadata.links.map((link) => link.link));
		}

		const headings: string[] = [];
		if (metadata?.headings) {
			headings.push(
				...metadata.headings.map((heading) => heading.heading)
			);
		}

		const noteData: NoteData = {
			title: file.basename,
			path: file.path,
			content: content,
			created: file.stat.ctime,
			modified: file.stat.mtime,
			frontmatter: frontmatter,
			tags: [...new Set(tags)],
			links: links,
			headings: headings,
		};

		return noteData;
	}

	async getChatbotResponse(message: string): Promise<string> {
		try {
			// Get notes context from database
			const notesContext = await this.fetchUserNotesFromAPI();

			// Better System Prompt
			const obsidianSystemPrompt = `You are Athena, an intelligent AI assistant specialized in helping with note-taking and knowledge management in Obsidian.

You have access to the user's recent notes as context. Use this information intelligently:

1. **Reference notes when relevant** - If the user asks about something in their notes, mention it and quote relevant parts
2. **Be conversational and helpful** - Don't just regurgitate notes. Provide opinions, suggestions, and insights based on the context
3. **Combine notes with general knowledge** - Use your notes as context but feel free to add your own analysis, opinions, and suggestions
4. **Be natural** - If someone asks for gift ideas and you see their notes about it, you can reference what they wrote AND add your own creative suggestions

For example:
- If they ask about Sarah's birthday: "I see in your notes you were considering [X, Y, Z]. Here are my thoughts on those options plus some additional ideas..."
- If they ask for opinions: Give actual opinions and analysis, not just "there are no opinions in your notes"

Be intelligent, conversational, and helpful - not a rigid search engine.`;

			// More natural prompt
			const enhancedPrompt = `${notesContext}\n\nUser: ${message}`;

			// Get or create conversation ID for this session
			if (!this.conversationId) {
				this.conversationId = `obsidian-${Date.now()}-${Math.random()
					.toString(36)
					.substr(2, 9)}`;
			}
			const baseUrl = this.settings.apiEndpoint.replace(
				"/obsidianaddon/note-data",
				""
			);
			const promptUrl = `${baseUrl}/chatbot/prompt`;
			const response = await requestUrl({
				url: promptUrl,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.settings.authToken}`,
				},
				body: JSON.stringify({
					hostEmail: this.settings.athenaUsername,
					conversationId: this.conversationId,
					systemPrompt: obsidianSystemPrompt,
					prompt: enhancedPrompt,
					images: [],
					audio: null,
				}),
			});
			console.log("[Athena Chatbot] Raw response text:", response.text);
			if (response.status === 200) {
				try {
					const responseText = response.text.trim();
					try {
						const data = JSON.parse(responseText);
						if (data.response) {
							if (
								typeof data.response === "object" &&
								data.response.stay22LinksOutput
							) {
								return data.response.stay22LinksOutput;
							}
							return data.response;
						}
						if (data.message) return data.message;
						if (data.text) return data.text;
						if (data.reply) return data.reply;
						return "I'm here to help with your notes!";
					} catch {
						const jsonObjects = [];
						const lines = responseText
							.split("\n")
							.filter((line) => line.trim());
						for (const line of lines) {
							try {
								const parsed = JSON.parse(line);
								if (parsed.response) {
									jsonObjects.push(parsed.response);
								} else if (parsed.message) {
									jsonObjects.push(parsed.message);
								}
							} catch {
								const matches = line.match(/\{[^}]*\}/g);
								if (matches) {
									for (const match of matches) {
										try {
											const parsed = JSON.parse(match);
											if (parsed.response) {
												jsonObjects.push(
													parsed.response
												);
											} else if (parsed.message) {
												jsonObjects.push(
													parsed.message
												);
											}
										} catch (e) {
											console.warn(
												"Failed to parse JSON chunk:",
												match
											);
										}
									}
								}
							}
						}
						return jsonObjects.join("\n");
					}
				} catch (err) {
					console.error("[Athena Chatbot] JSON parse error:", err);
					return `Error: Response was not valid JSON. Raw response: ${response.text}`;
				}
			} else if (response.status === 401) {
				this.settings.isAuthenticated = false;
				await this.saveSettings();
				return "Authentication expired. Please login again.";
			} else {
				throw new Error(`API Error: ${response.status}`);
			}
		} catch (error) {
			console.error("Chatbot API error:", error);
			return "Error: Unable to fetch response.";
		}
	}
}

class SettingsModal extends Modal {
	plugin: NoteScraperPlugin;

	constructor(app: App, plugin_: NoteScraperPlugin) {
		super(app);
		this.plugin = plugin_;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.empty();
		contentEl.createEl("h2", { text: "Athena AI Settings" });
		contentEl.createEl("p", {
			text: "Configure your Athena AI credentials here.",
		});

		// Username setting
		new Setting(contentEl)
			.setName("Username")
			.setDesc("Enter your Athena AI email")
			.addText((text) =>
				text
					.setPlaceholder("Enter your email")
					.setValue(this.plugin.settings.athenaUsername)
					.onChange(async (value) => {
						this.plugin.settings.athenaUsername = value;
						await this.plugin.saveSettings();
					})
			);

		// Password setting
		new Setting(contentEl)
			.setName("Password")
			.setDesc("Enter your Athena AI password")
			.addText((text) => {
				text.setPlaceholder("Enter your password")
					.setValue(this.plugin.settings.athenaPassword)
					.onChange(async (value) => {
						this.plugin.settings.athenaPassword = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
				return text;
			});

		// NEW: Auto-scraping toggle
		new Setting(contentEl)
			.setName("Auto-scraping")
			.setDesc("Automatically scrape notes when they are modified")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoScrapingEnabled)
					.onChange(async (value) => {
						this.plugin.settings.autoScrapingEnabled = value;
						await this.plugin.saveSettings();

						// Refresh chatbot view to update status
						const leaves =
							this.plugin.app.workspace.getLeavesOfType(
								CHATBOT_VIEW_TYPE
							);
						if (
							leaves.length &&
							leaves[0].view instanceof ChatbotView
						) {
							await leaves[0].view.refreshView();
						}
					})
			);

		// NEW: Auto-scrape delay setting
		new Setting(contentEl)
			.setName("Auto-scrape delay")
			.setDesc(
				"Delay in seconds after typing before auto-scraping (1-10 seconds)"
			)
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.autoScrapeDelay / 1000)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.autoScrapeDelay = value * 1000;
						await this.plugin.saveSettings();
					})
			);

		// Login Button
		const loginButton = contentEl.createEl("button", { text: "Login" });
		loginButton.style.cssText = `
            margin: 10px 0; 
            padding: 8px 16px; 
            background: var(--interactive-accent); 
            color: var(--text-on-accent); 
            border: none; 
            border-radius: 4px; 
            cursor: pointer;
        `;

		loginButton.onclick = async () => {
			if (
				!this.plugin.settings.athenaUsername ||
				!this.plugin.settings.athenaPassword
			) {
				new Notice("Please enter both username and password.");
				return;
			}

			loginButton.textContent = "Logging in...";
			loginButton.disabled = true;

			try {
				const success = await this.plugin.authenticate(
					this.plugin.settings.athenaUsername,
					this.plugin.settings.athenaPassword
				);

				if (success) {
					new Notice("Login successful!");
					this.onOpen(); // Refresh modal
				} else {
					new Notice("Login failed. Please check your credentials.");
				}
			} catch (error) {
				console.error("Login error:", error);
				new Notice("Login failed. Please try again.");
			} finally {
				loginButton.textContent = "Login";
				loginButton.disabled = false;
			}
		};

		// Status indicator
		const statusEl = contentEl.createEl("div", { cls: "athena-status" });
		if (this.plugin.settings.isAuthenticated) {
			statusEl.createEl("p", {
				text: "✅ Authenticated and ready!",
				cls: "athena-status-success",
			});

			// NEW: Show auto-scraping status
			const autoScrapeStatus = this.plugin.settings.autoScrapingEnabled
				? "enabled"
				: "disabled";
			statusEl.createEl("p", {
				text: `🔄 Auto-scraping: ${autoScrapeStatus} (${
					this.plugin.settings.autoScrapeDelay / 1000
				}s delay)`,
				cls: "athena-status-info",
			});
		} else if (
			this.plugin.settings.athenaUsername &&
			this.plugin.settings.athenaPassword
		) {
			statusEl.createEl("p", {
				text: "⚠️ Please login with your credentials.",
				cls: "athena-status-warning",
			});
		} else {
			statusEl.createEl("p", {
				text: "❌ Please enter your credentials.",
				cls: "athena-status-error",
			});
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
