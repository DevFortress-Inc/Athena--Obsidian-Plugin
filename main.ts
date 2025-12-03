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
	baseUrl: string;
	apiEndpoint: string;
	loginEndpoint: string;
	logoutEndpoint: string;
	signupEndpoint: string;
	chatEndpoint: string;
	notesEndpoint: string;
	conversationsEndpoint: string;
	isAuthenticated: boolean;
	authToken?: string;
	autoScrapingEnabled: boolean;
	autoScrapeDelay: number;
}

// Conversation interfaces
interface ConversationMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: string;
}

interface ConversationSummary {
	id: string;
	title: string;
	messageCount: number;
	createdAt: string;
	updatedAt: string;
}

interface Conversation {
	id: string;
	title: string;
	messages: ConversationMessage[];
}

const buildEndpointConfig = (baseUrl: string) => {
	const normalizedBase = baseUrl?.replace(/\/+$/, "") || "";

	return {
		apiEndpoint: `${normalizedBase}/obsidianaddon/note-data`,
		loginEndpoint: `${normalizedBase}/obsidianaddon/login`,
		logoutEndpoint: `${normalizedBase}/obsidianaddon/logout`,
		signupEndpoint: `${normalizedBase}/chatbot/signup`,
		chatEndpoint: `${normalizedBase}/chatbot/prompt`,
		notesEndpoint: `${normalizedBase}/obsidianaddon/notes`,
		conversationsEndpoint: `${normalizedBase}/obsidianaddon/conversations`,
	};
};

const DEFAULT_SETTINGS: ScraperSettings = {
	athenaUsername: "",
	athenaPassword: "",
	baseUrl: "https://athenachat.bot",
	...buildEndpointConfig("https://athenachat.bot"),
	isAuthenticated: false,
	autoScrapingEnabled: true,
	autoScrapeDelay: 3000,
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
	plugin: AthenaPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: AthenaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CHATBOT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Athena";
	}

	getIcon(): string {
		return "message-circle";  // Chat icon
	}

	async onOpen(): Promise<void> {
		await this.refreshView();
	}

	// Store conversation history for context
	private conversationHistory: Array<{role: string, content: string}> = [];
	private currentConversationId: string | null = null;
	private showHistorySidebar: boolean = false;
	private showSettings: boolean = false;

	// NEW: Public method to refresh the view
	async refreshView(): Promise<void> {
		const container = this.containerEl.children[1];

		if (!container) {
			console.error("ChatbotView: Container not found");
			return;
		}

		container.empty();
		container.addClass("athena-main-container");

		// Add Athena logo and title header
		const headerDiv = container.createDiv({ cls: "athena-chatbot-header" });
		
		const logoContainer = headerDiv.createDiv({ cls: "athena-logo-container" });
		const logoImg = logoContainer.createEl("img", {
			attr: {
				src: "https://athenachat.bot/assets/athena/logo.png",
				alt: "Athena Logo",
			},
			cls: "athena-logo-img",
		});
		// fallback badge if image fails
		logoImg.onerror = () => {
			logoImg.replaceWith(
				createEl("div", {
					text: "A",
					attr: { class: "athena-logo-fallback" },
				})
			);
		};
		
		const titleContainer = headerDiv.createDiv({ cls: "athena-title-container" });
		titleContainer.createEl("h2", {
			text: "Athena",
			cls: "athena-chatbot-title",
		});
		titleContainer.createEl("span", {
			text: "Your AI Knowledge Assistant",
			cls: "athena-chatbot-subtitle",
		});

		// Header actions (history + new chat + settings)
		const headerActions = headerDiv.createDiv({ cls: "athena-header-actions" });
		
		// History button
		const historyBtn = headerActions.createEl("button", { cls: "athena-icon-btn", attr: { title: "Chat History" } });
		historyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
		
		// New chat button
		const newChatBtn = headerActions.createEl("button", { cls: "athena-icon-btn athena-new-chat-btn", attr: { title: "New Chat" } });
		newChatBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
		
		// Settings button
		const settingsBtn = headerActions.createEl("button", { cls: "athena-icon-btn", attr: { title: "Settings" } });
		settingsBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
		
		newChatBtn.onclick = () => {
			this.conversationHistory = [];
			this.currentConversationId = null;
			this.showSettings = false;
			this.refreshView();
		};
		
		settingsBtn.onclick = () => {
			this.showSettings = !this.showSettings;
			this.refreshView();
		};

		// Show settings panel if toggled
		if (this.showSettings) {
			this.renderSettingsPanel(container);
			return;
		}

		// Check if authenticated
		if (!this.plugin.settings.isAuthenticated) {
			this.renderLoginPanel(container);
			return;
		}

		// Main layout with sidebar
		const mainLayout = container.createDiv({ cls: "athena-main-layout" });
		
		// History sidebar (hidden by default)
		const historySidebar = mainLayout.createDiv({ cls: "athena-history-sidebar" });
		historySidebar.style.display = this.showHistorySidebar ? "flex" : "none";
		
		const sidebarHeader = historySidebar.createDiv({ cls: "athena-sidebar-header" });
		sidebarHeader.createEl("h3", { text: "Chat History", cls: "athena-sidebar-title" });
		const closeSidebarBtn = sidebarHeader.createEl("button", { cls: "athena-close-sidebar-btn", text: "×" });
		closeSidebarBtn.onclick = () => {
			this.showHistorySidebar = false;
			historySidebar.style.display = "none";
		};
		
		const conversationsList = historySidebar.createDiv({ cls: "athena-conversations-list" });
		
		// Load conversations
		this.loadConversationsList(conversationsList, historySidebar);
		
		// Toggle sidebar on history button click
		historyBtn.onclick = () => {
			this.showHistorySidebar = !this.showHistorySidebar;
			historySidebar.style.display = this.showHistorySidebar ? "flex" : "none";
			if (this.showHistorySidebar) {
				this.loadConversationsList(conversationsList, historySidebar);
			}
		};

		// Main chat container
		const chatContainer = mainLayout.createDiv({ cls: "athena-chat-container" });
		
		// Chat messages area
		const chatLog = chatContainer.createEl("div", { cls: "athena-chat-log" });
		
		// Welcome message
		const welcomeMsg = chatLog.createDiv({ cls: "athena-welcome-message" });
		welcomeMsg.createEl("div", { cls: "athena-welcome-icon", text: "✨" });
		welcomeMsg.createEl("h4", { text: "How can I help you today?", cls: "athena-welcome-title" });
		welcomeMsg.createEl("p", { 
			text: "Ask me anything about your notes, or let me help you brainstorm ideas.",
			cls: "athena-welcome-desc"
		});
		
		// Quick action suggestions
		const quickActions = welcomeMsg.createDiv({ cls: "athena-quick-actions" });
		const suggestions = [
			"📝 Summarize @",
			"✨ Create a note about...",
			"🔍 What do my notes say about..."
		];
		suggestions.forEach(suggestion => {
			const chip = quickActions.createEl("button", { 
				text: suggestion, 
				cls: "athena-suggestion-chip" 
			});
			chip.onclick = () => {
				chatInput.value = suggestion.replace(/^[^\s]+\s/, '');
				chatInput.focus();
			};
		});
		
		// Help tip
		const helpTip = welcomeMsg.createDiv({ cls: "athena-help-tip" });
		helpTip.innerHTML = `💡 <strong>Tip:</strong> Use <code>@NoteName</code> to reference specific notes, or ask me to create new notes!`;

		// Input area
		const inputContainer = chatContainer.createDiv({ cls: "athena-input-container" });
		
		// Note autocomplete dropdown
		const autocompleteDropdown = inputContainer.createDiv({ cls: "athena-autocomplete-dropdown" });
		autocompleteDropdown.style.display = "none";
		
		const inputWrapper = inputContainer.createDiv({ cls: "athena-input-wrapper" });
		const chatInput = inputWrapper.createEl("textarea", {
			cls: "athena-chat-input",
			attr: { placeholder: "Ask anything... Use @NoteName to reference notes", rows: "1" }
		});
		
		const sendButton = inputWrapper.createEl("button", {
			cls: "athena-send-btn",
		});
		sendButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;

		// Auto-resize textarea
		chatInput.addEventListener("input", () => {
			chatInput.style.height = "auto";
			chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
			
			// Check for @ mention
			this.handleNoteMention(chatInput, autocompleteDropdown);
		});

		// Add Enter key support
		chatInput.addEventListener("keydown", async (e) => {
			// Handle autocomplete navigation
			if (autocompleteDropdown.style.display !== "none") {
				const items = autocompleteDropdown.querySelectorAll(".athena-autocomplete-item");
				const activeItem = autocompleteDropdown.querySelector(".athena-autocomplete-item.active");
				
				if (e.key === "ArrowDown") {
					e.preventDefault();
					if (activeItem) {
						activeItem.removeClass("active");
						const next = activeItem.nextElementSibling || items[0];
						next?.addClass("active");
					} else if (items.length) {
						items[0].addClass("active");
					}
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					if (activeItem) {
						activeItem.removeClass("active");
						const prev = activeItem.previousElementSibling || items[items.length - 1];
						prev?.addClass("active");
					} else if (items.length) {
						items[items.length - 1].addClass("active");
					}
					return;
				}
				if (e.key === "Tab" || e.key === "Enter") {
					if (activeItem) {
						e.preventDefault();
						(activeItem as HTMLElement).click();
						return;
					}
				}
				if (e.key === "Escape") {
					autocompleteDropdown.style.display = "none";
					return;
				}
			}
			
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				sendButton.click();
			}
		});

		sendButton.onclick = async () => {
			const userMessage = chatInput.value.trim();
			if (!userMessage) return;

			// Create conversation ID if new chat
			if (!this.currentConversationId) {
				this.currentConversationId = `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
			}

			// Hide welcome message on first interaction
			if (welcomeMsg.style.display !== "none") {
				welcomeMsg.style.display = "none";
			}

			// Add user message to chat
			const userMsgContainer = chatLog.createDiv({ cls: "athena-message-row athena-user-row" });
			const userMessageEl = userMsgContainer.createDiv({ cls: "athena-message athena-user-message" });
			userMessageEl.createEl("p", { text: userMessage });
			
			// Add timestamp
			const userTime = userMsgContainer.createEl("span", { 
				cls: "athena-message-time",
				text: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			});

			chatInput.value = "";
			chatInput.style.height = "auto";

			// Save user message to cloud
			this.plugin.saveMessage(this.currentConversationId, "user", userMessage);

			// Add bot thinking message with typing indicator
			const botMsgContainer = chatLog.createDiv({ cls: "athena-message-row athena-bot-row" });
			const botAvatar = botMsgContainer.createDiv({ cls: "athena-bot-avatar" });
			botAvatar.innerHTML = `<img src="https://athenachat.bot/assets/athena/logo.png" alt="Athena" onerror="this.style.display='none'" />`;
			
			const botMessageEl = botMsgContainer.createDiv({ cls: "athena-message athena-bot-message" });
			const typingIndicator = botMessageEl.createDiv({ cls: "athena-typing-indicator" });
			typingIndicator.innerHTML = `<span></span><span></span><span></span>`;

			// Scroll to bottom
			chatLog.scrollTop = chatLog.scrollHeight;

			// Store user message in history
			this.conversationHistory.push({ role: "user", content: userMessage });

			try {
				const response = await this.plugin.getChatbotResponse(
					userMessage,
					this.conversationHistory
				);

				// Store assistant response in history
				this.conversationHistory.push({ role: "assistant", content: response });
				
				// Save assistant response to cloud
				this.plugin.saveMessage(this.currentConversationId, "assistant", response);

				// Clear typing indicator
				typingIndicator.remove();

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
				
				// Add timestamp for bot
				const botTime = botMsgContainer.createEl("span", { 
					cls: "athena-message-time",
					text: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
				});
				
			} catch (error) {
				typingIndicator.remove();
				botMessageEl.createEl("p", { 
					text: "Sorry, I couldn't process that request. Please try again.",
					cls: "athena-error-text"
				});
				console.error(error);
			}

			// Scroll to bottom again
			chatLog.scrollTop = chatLog.scrollHeight;
		};

	}

	// Handle @NoteName mentions with autocomplete
	private handleNoteMention(input: HTMLTextAreaElement, dropdown: HTMLElement): void {
		const text = input.value;
		const cursorPos = input.selectionStart;
		
		// Find @ symbol before cursor
		const textBeforeCursor = text.substring(0, cursorPos);
		const atMatch = textBeforeCursor.match(/@(\w*)$/);
		
		if (atMatch) {
			const searchTerm = atMatch[1].toLowerCase();
			const files = this.plugin.app.vault.getMarkdownFiles();
			
			// Filter files by search term
			const matches = files
				.filter(f => f.basename.toLowerCase().includes(searchTerm))
				.slice(0, 6);
			
			if (matches.length > 0) {
				dropdown.empty();
				dropdown.style.display = "block";
				
				matches.forEach((file, index) => {
					const item = dropdown.createDiv({ 
						cls: `athena-autocomplete-item ${index === 0 ? 'active' : ''}`,
						text: file.basename
					});
					item.onclick = () => {
						// Replace @search with @NoteName
						const before = text.substring(0, cursorPos - atMatch[0].length);
						const after = text.substring(cursorPos);
						input.value = `${before}@${file.basename} ${after}`;
						input.focus();
						dropdown.style.display = "none";
					};
				});
			} else {
				dropdown.style.display = "none";
			}
		} else {
			dropdown.style.display = "none";
		}
	}

	// Render login panel
	private renderLoginPanel(container: Element): void {
		const loginPanel = (container as HTMLElement).createDiv({ cls: "athena-login-panel" });
		
		// Logo
		const logoSection = loginPanel.createDiv({ cls: "athena-login-logo" });
		const logo = logoSection.createEl("img", {
			attr: { src: "https://athenachat.bot/assets/athena/logo.png", alt: "Athena" }
		});
		logo.onerror = () => {
			logo.replaceWith(createEl("div", { text: "A", cls: "athena-logo-fallback-large" }));
		};
		
		loginPanel.createEl("h2", { text: "Welcome to Athena", cls: "athena-login-heading" });
		loginPanel.createEl("p", { text: "Sign in to chat with your notes using AI", cls: "athena-login-subtext" });

		// Form
		const form = loginPanel.createDiv({ cls: "athena-login-form" });
		
		// Email
		const emailGroup = form.createDiv({ cls: "athena-form-group" });
		emailGroup.createEl("label", { text: "Email", cls: "athena-label" });
		const emailInput = emailGroup.createEl("input", {
			cls: "athena-field",
			attr: { type: "email", placeholder: "you@example.com" }
		});
		emailInput.value = this.plugin.settings.athenaUsername;

		// Password
		const passGroup = form.createDiv({ cls: "athena-form-group" });
		passGroup.createEl("label", { text: "Password", cls: "athena-label" });
		const passwordInput = passGroup.createEl("input", {
			cls: "athena-field",
			attr: { type: "password", placeholder: "Enter your password" }
		});

		// Login button
		const loginBtn = form.createEl("button", { text: "Sign In", cls: "athena-btn-primary" });
		
		loginBtn.onclick = async () => {
			const email = emailInput.value.trim();
			const password = passwordInput.value;
			
			if (!email || !password) {
				new Notice("Please enter email and password");
				return;
			}
			
			loginBtn.textContent = "Signing in...";
			loginBtn.disabled = true;
			
			const success = await this.plugin.authenticate(email, password);
			
			if (success) {
				new Notice("✅ Signed in successfully!");
				this.refreshView();
			} else {
				new Notice("❌ Sign in failed. Check your credentials.");
				loginBtn.textContent = "Sign In";
				loginBtn.disabled = false;
			}
		};

		// Signup link
		const footer = loginPanel.createDiv({ cls: "athena-login-footer" });
		footer.innerHTML = `Don't have an account? <a href="https://athenachat.bot/chatbot" target="_blank">Create one free</a>`;
	}

	// Render settings panel
	private renderSettingsPanel(container: Element): void {
		const panel = (container as HTMLElement).createDiv({ cls: "athena-settings-view" });
		
		// Header with back button
		const header = panel.createDiv({ cls: "athena-settings-header" });
		const backBtn = header.createEl("button", { cls: "athena-back-button" });
		backBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>`;
		backBtn.onclick = () => { this.showSettings = false; this.refreshView(); };
		header.createEl("h2", { text: "Settings", cls: "athena-settings-heading" });

		const content = panel.createDiv({ cls: "athena-settings-content" });

		// Account Card
		const accountCard = content.createDiv({ cls: "athena-card" });
		accountCard.createEl("h3", { text: "Account", cls: "athena-card-title" });
		
		if (this.plugin.settings.isAuthenticated) {
			const userInfo = accountCard.createDiv({ cls: "athena-user-info" });
			const avatar = userInfo.createDiv({ cls: "athena-user-avatar" });
			avatar.textContent = this.plugin.settings.athenaUsername.charAt(0).toUpperCase();
			const details = userInfo.createDiv({ cls: "athena-user-details" });
			details.createEl("span", { text: this.plugin.settings.athenaUsername, cls: "athena-user-email" });
			details.createEl("span", { text: "Connected", cls: "athena-user-status" });
			
			const logoutBtn = accountCard.createEl("button", { text: "Sign Out", cls: "athena-btn-outline-danger" });
			logoutBtn.onclick = async () => {
				this.plugin.settings.isAuthenticated = false;
				this.plugin.settings.authToken = undefined;
				await this.plugin.saveSettings();
				new Notice("Signed out");
				this.showSettings = false;
				this.refreshView();
			};
		} else {
			accountCard.createEl("p", { text: "Not signed in", cls: "athena-text-muted" });
			const signInBtn = accountCard.createEl("button", { text: "Sign In", cls: "athena-btn-primary" });
			signInBtn.onclick = () => { this.showSettings = false; this.refreshView(); };
		}

		// Sync Card
		const syncCard = content.createDiv({ cls: "athena-card" });
		syncCard.createEl("h3", { text: "Note Sync", cls: "athena-card-title" });
		
		const syncRow = syncCard.createDiv({ cls: "athena-setting-row" });
		const syncLabel = syncRow.createDiv({ cls: "athena-setting-label" });
		syncLabel.createEl("span", { text: "Auto-sync notes", cls: "athena-setting-name" });
		syncLabel.createEl("span", { text: "Sync notes to cloud so AI can access them across devices", cls: "athena-setting-desc" });
		
		// Custom toggle button instead of checkbox
		const toggleBtn = syncRow.createEl("button", { cls: "athena-toggle-btn" });
		toggleBtn.addClass(this.plugin.settings.autoScrapingEnabled ? "athena-toggle-on" : "athena-toggle-off");
		toggleBtn.textContent = this.plugin.settings.autoScrapingEnabled ? "ON" : "OFF";
		
		toggleBtn.onclick = async () => {
			this.plugin.settings.autoScrapingEnabled = !this.plugin.settings.autoScrapingEnabled;
			await this.plugin.saveSettings();
			toggleBtn.textContent = this.plugin.settings.autoScrapingEnabled ? "ON" : "OFF";
			toggleBtn.removeClass("athena-toggle-on", "athena-toggle-off");
			toggleBtn.addClass(this.plugin.settings.autoScrapingEnabled ? "athena-toggle-on" : "athena-toggle-off");
			new Notice(this.plugin.settings.autoScrapingEnabled ? "Auto-sync enabled" : "Auto-sync disabled");
		};

		if (this.plugin.settings.isAuthenticated) {
			const syncBtn = syncCard.createEl("button", { text: "Sync All Notes Now", cls: "athena-btn-secondary" });
			syncBtn.onclick = async () => {
				syncBtn.textContent = "Syncing...";
				syncBtn.disabled = true;
				try {
					const files = this.plugin.app.vault.getMarkdownFiles();
					for (const file of files) { await this.plugin.syncNote(file); }
					new Notice(`✅ Synced ${files.length} notes`);
				} catch (e) { new Notice("❌ Sync failed"); }
				syncBtn.textContent = "Sync All Notes Now";
				syncBtn.disabled = false;
			};
		}

		// Usage Limits Card
		const limitsCard = content.createDiv({ cls: "athena-card" });
		limitsCard.createEl("h3", { text: "Usage Limits", cls: "athena-card-title" });
		const limitsInfo = limitsCard.createDiv({ cls: "athena-limits-info" });
		limitsInfo.createEl("p", { text: "Free: 10 messages/day", cls: "athena-text-muted" });
		limitsInfo.createEl("p", { text: "Pro: Unlimited messages", cls: "athena-text-muted" });
		const upgradeLink = limitsCard.createEl("a", { 
			text: "Upgrade to Pro →", 
			href: "https://athenachat.bot/pricing", 
			cls: "athena-link athena-upgrade-link" 
		});

		// About Card
		const aboutCard = content.createDiv({ cls: "athena-card" });
		aboutCard.createEl("h3", { text: "About", cls: "athena-card-title" });
		aboutCard.createEl("p", { text: "Athena AI - Your intelligent note assistant powered by AI.", cls: "athena-text-muted" });
		aboutCard.createEl("a", { text: "Visit athenachat.bot →", href: "https://athenachat.bot/chatbot", cls: "athena-link" });
	}

	// Load conversations list in sidebar
	private async loadConversationsList(listContainer: HTMLElement, sidebar: HTMLElement): Promise<void> {
		listContainer.empty();
		
		// Loading state
		const loadingEl = listContainer.createDiv({ cls: "athena-loading", text: "Loading..." });
		
		try {
			const conversations = await this.plugin.fetchConversations();
			loadingEl.remove();
			
			if (conversations.length === 0) {
				listContainer.createDiv({ 
					cls: "athena-empty-state", 
					text: "No conversations yet. Start chatting!" 
				});
				return;
			}
			
			conversations.forEach(conv => {
				const convItem = listContainer.createDiv({ cls: "athena-conversation-item" });
				
				const convInfo = convItem.createDiv({ cls: "athena-conv-info" });
				convInfo.createEl("span", { 
					cls: "athena-conv-title", 
					text: conv.title.substring(0, 40) + (conv.title.length > 40 ? "..." : "")
				});
				convInfo.createEl("span", { 
					cls: "athena-conv-date", 
					text: new Date(conv.updatedAt).toLocaleDateString()
				});
				
				// Click to load conversation
				convItem.onclick = async () => {
					await this.loadConversation(conv.id);
					sidebar.style.display = "none";
					this.showHistorySidebar = false;
				};
				
				// Delete button
				const deleteBtn = convItem.createEl("button", { cls: "athena-conv-delete", text: "×" });
				deleteBtn.onclick = async (e) => {
					e.stopPropagation();
					if (confirm("Delete this conversation?")) {
						await this.plugin.deleteConversation(conv.id);
						convItem.remove();
						new Notice("Conversation deleted");
					}
				};
			});
		} catch (error) {
			loadingEl.textContent = "Failed to load conversations";
			console.error("Failed to load conversations:", error);
		}
	}

	// Load a specific conversation
	private async loadConversation(conversationId: string): Promise<void> {
		const conversation = await this.plugin.fetchConversation(conversationId);
		if (!conversation) {
			new Notice("Failed to load conversation");
			return;
		}
		
		this.currentConversationId = conversationId;
		this.conversationHistory = conversation.messages.map(m => ({
			role: m.role,
			content: m.content
		}));
		
		// Refresh view to show loaded conversation
		await this.refreshView();
		
		// Re-render messages in chat log
		const chatLog = this.containerEl.querySelector(".athena-chat-log");
		const welcomeMsg = this.containerEl.querySelector(".athena-welcome-message");
		
		if (chatLog && welcomeMsg) {
			(welcomeMsg as HTMLElement).style.display = "none";
			
			for (const msg of conversation.messages) {
				if (msg.role === "user") {
					const userMsgContainer = chatLog.createDiv({ cls: "athena-message-row athena-user-row" });
					const userMessageEl = userMsgContainer.createDiv({ cls: "athena-message athena-user-message" });
					userMessageEl.createEl("p", { text: msg.content });
				} else {
					const botMsgContainer = chatLog.createDiv({ cls: "athena-message-row athena-bot-row" });
					const botAvatar = botMsgContainer.createDiv({ cls: "athena-bot-avatar" });
					botAvatar.innerHTML = `<img src="https://athenachat.bot/assets/athena/logo.png" alt="Athena" />`;
					const botMessageEl = botMsgContainer.createDiv({ cls: "athena-message athena-bot-message" });
					
					const component = new Component();
					try {
						await MarkdownRenderer.renderMarkdown(msg.content, botMessageEl, "", component);
						component.load();
					} catch {
						botMessageEl.innerHTML = this.parseBasicMarkdown(msg.content);
					}
				}
			}
		}
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

export default class AthenaPlugin extends Plugin {
	// Build context from locally scraped notes with improved formatting
	private buildLocalNotesContext(): string {
		if (!this.allNotesData.length) {
			return "\n[No notes available in context. The user may not have synced any notes yet.]\n";
		}

		let context = "\n\n=== USER'S NOTES CONTEXT ===\n";
		context += `Total notes available: ${this.allNotesData.length}\n\n`;
		
		// Get most recent notes, prioritizing recently modified
		const sortedNotes = [...this.allNotesData]
			.sort((a, b) => b.modified - a.modified)
			.slice(0, 8);

		sortedNotes.forEach((note, index) => {
			context += `--- Note ${index + 1}: "${note.title}" ---\n`;
			
			// Add metadata
			if (note.tags?.length) {
				context += `Tags: ${note.tags.join(", ")}\n`;
			}
			if (note.headings?.length) {
				context += `Structure: ${note.headings.slice(0, 5).join(" > ")}${note.headings.length > 5 ? '...' : ''}\n`;
			}
			if (note.links?.length) {
				context += `Links to: ${note.links.slice(0, 3).join(", ")}${note.links.length > 3 ? ` (+${note.links.length - 3} more)` : ''}\n`;
			}
			
			// Clean and truncate content intelligently
			const cleanContent = note.content
				.replace(/^---[\s\S]*?---\n*/m, '') // Remove frontmatter
				.replace(/\n{3,}/g, '\n\n') // Normalize line breaks
				.trim();
			
			const maxLength = 600;
			const truncatedContent = cleanContent.length > maxLength 
				? cleanContent.substring(0, maxLength) + "..." 
				: cleanContent;
			
			context += `Content:\n${truncatedContent}\n\n`;
		});

		context += "=== END OF NOTES CONTEXT ===\n\n";
		context += "Use these notes to provide personalized, contextual responses. Reference specific notes when relevant.\n";
		
		return context;
	}

	// Fetch user's notes from backend API for chatbot context
	private async fetchUserNotesFromAPI(): Promise<string> {
		// Always get local vault context as fallback
		const localContext = await this.getVaultNotesContext();

		if (!this.settings.authToken || !this.settings.isAuthenticated) {
			return localContext;
		}
		try {
			const baseUrl = this.settings.apiEndpoint.replace(
				"/obsidianaddon/note-data",
				""
			);
			const notesUrl = `${baseUrl}/obsidianaddon/user-notes`;
			const response = await requestUrl({
				url: notesUrl,
				method: "GET",
				headers: this.buildAuthHeaders({
					"Content-Type": "application/json",
					"ngrok-skip-browser-warning": "true",
				}),
			});

			if (response.status === 200) {
				const notes = JSON.parse(response.text);
				
				let context = "\n\n=== USER'S CLOUD NOTES ===\n";
				context += `Total synced notes: ${notes.length}\n\n`;

				notes.slice(0, 8).forEach((note: any, index: number) => {
					context += `--- Note ${index + 1}: "${note.title}" ---\n`;
					
					if (note.tags?.length) {
						context += `Tags: ${note.tags.join(", ")}\n`;
					}
					
					const cleanContent = (note.content || '')
						.replace(/^---[\s\S]*?---\n*/m, '')
						.replace(/\n{3,}/g, '\n\n')
						.trim();
					
					const maxLength = 600;
					context += `Content:\n${cleanContent.substring(0, maxLength)}${cleanContent.length > maxLength ? '...' : ''}\n\n`;
				});

				context += "=== END OF CLOUD NOTES ===\n\n";
				return context;
			} else if (response.status === 404) {
				return localContext;
			} else {
				console.error(
					"❌ Non-200 response:",
					response.status,
					response.text
				);
				return localContext;
			}
		} catch (error) {
			console.error("❌ Failed to fetch notes from API:", error);
			console.error("Error details:", error.message);
			return localContext;
		}
	}

	settings: ScraperSettings;
	private allNotesData: NoteData[] = [];
	private conversationId: string;
	private autoScrapeTimeout: NodeJS.Timeout; // NEW: Auto-scrape timeout
	private notesLoaded: boolean = false;
	private notesIndex: Array<{path: string, title: string, tags: string[], headings: string[], preview: string}> = [];

	async onload(): Promise<void> {

		await this.loadSettings();

		const ribbonIconEl = this.addRibbonIcon(
			"message-circle",
			"Toggle Athena AI",
			async () => {
				// Toggle the chatbot view (show/hide)
				const existing = this.app.workspace.getLeavesOfType(CHATBOT_VIEW_TYPE);
				
				if (existing.length > 0) {
					// Close all instances
					existing.forEach(leaf => leaf.detach());
				} else {
					// Open new instance
					const leaf = this.app.workspace.getRightLeaf(false);
					if (leaf) {
						await leaf.setViewState({ type: CHATBOT_VIEW_TYPE, active: true });
						this.app.workspace.revealLeaf(leaf);
					}
				}
			}
		);
		ribbonIconEl.addClass("athena-ribbon-icon");

		this.registerView(CHATBOT_VIEW_TYPE, (leaf) => {
			return new ChatbotView(leaf, this);
		});

		// Ensure the workspace is ready before adding the chatbot view
		this.app.workspace.onLayoutReady(async () => {
			if (!this.app.workspace.getLeavesOfType(CHATBOT_VIEW_TYPE).length) {
				const rightLeaf = this.app.workspace.getRightLeaf(false);
				if (rightLeaf) {
					rightLeaf.setViewState({
						type: CHATBOT_VIEW_TYPE,
					});
				}
			}
			
			// Load vault notes into memory for local context
			await this.loadVaultNotesIntoMemory();
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
				await this.refreshChatViewIfOpen();
			},
		});
	}

	onunload(): void {
		// NEW: Clear any pending auto-scrape timeouts
		if (this.autoScrapeTimeout) {
			clearTimeout(this.autoScrapeTimeout);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);

		const normalizedBase =
			this.settings.baseUrl || DEFAULT_SETTINGS.baseUrl;
		const endpoints = buildEndpointConfig(normalizedBase);
		let updated = false;

		(
			[
				"apiEndpoint",
				"loginEndpoint",
				"logoutEndpoint",
				"signupEndpoint",
				"chatEndpoint",
				"notesEndpoint",
				"conversationsEndpoint",
			] as const
		).forEach((key) => {
			if (this.settings[key] !== endpoints[key]) {
				this.settings[key] = endpoints[key];
				updated = true;
			}
		});

		if (updated) {
			await this.saveData(this.settings);
		}
	}


	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private extractAuthCookie(
		headers: Record<string, string | string[]>
	): string | null {
		if (!headers) return null;
		for (const [key, value] of Object.entries(headers)) {
			if (key?.toLowerCase() !== "set-cookie" || !value) continue;
			const cookies = Array.isArray(value) ? value : [value];
			const cookie = cookies.find((item) =>
				item.startsWith("authentication=")
			);
			if (cookie) {
				return cookie.split(";")[0];
			}
		}
		return null;
	}

	public applyAuthFromResponse(
		resp: Awaited<ReturnType<typeof requestUrl>>
	): boolean {
		const cookie = this.extractAuthCookie(resp.headers as any);
		if (cookie) {
			this.settings.authToken = cookie;
			this.settings.isAuthenticated = true;
			return true;
		}
		return false;
	}

	private buildAuthHeaders(
		headers: Record<string, string> = {}
	): Record<string, string> {
		const finalHeaders = { ...headers };
		if (this.settings.authToken) {
			finalHeaders["Cookie"] = this.settings.authToken;
		}
		return finalHeaders;
	}

	public async refreshChatViewIfOpen() {
		const leaves =
			this.app.workspace.getLeavesOfType(CHATBOT_VIEW_TYPE);
		if (leaves.length && leaves[0].view instanceof ChatbotView) {
			await leaves[0].view.refreshView();
		}
	}

	// Activate/open the chatbot view
	async activateView() {
		const { workspace } = this.app;
		
		// Check if view already exists
		const existing = workspace.getLeavesOfType(CHATBOT_VIEW_TYPE);
		if (existing.length) {
			workspace.revealLeaf(existing[0]);
			return;
		}
		
		// Create in right sidebar
		const leaf = workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: CHATBOT_VIEW_TYPE,
				active: true,
			});
			workspace.revealLeaf(leaf);
		}
	}

	async authenticate(username: string, password: string): Promise<boolean> {
		try {
			const resp = await requestUrl({
				url: this.settings.loginEndpoint,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: username, password }),
			});

			if (resp.status === 200) {
				const data = JSON.parse(resp.text);
				const authReady = this.applyAuthFromResponse(resp);
				if (!authReady) {
					console.warn("Login succeeded but no session cookie returned.");
					return false;
				}
				this.settings.athenaUsername = data.email || username;
				await this.saveSettings();
				await this.refreshChatViewIfOpen();
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

	// ============ CONVERSATION API METHODS ============

	// Fetch all conversations list
	async fetchConversations(): Promise<ConversationSummary[]> {
		if (!this.settings.isAuthenticated) return [];
		
		try {
			const resp = await requestUrl({
				url: this.settings.conversationsEndpoint,
				method: "GET",
				headers: this.buildAuthHeaders({ "Content-Type": "application/json" }),
			});
			
			if (resp.status === 200) {
				const data = JSON.parse(resp.text);
				return data.conversations || [];
			}
			return [];
		} catch (error) {
			console.error("Failed to fetch conversations:", error);
			return [];
		}
	}

	// Fetch single conversation with messages
	async fetchConversation(conversationId: string): Promise<Conversation | null> {
		if (!this.settings.isAuthenticated) return null;
		
		try {
			const resp = await requestUrl({
				url: `${this.settings.conversationsEndpoint}/${conversationId}`,
				method: "GET",
				headers: this.buildAuthHeaders({ "Content-Type": "application/json" }),
			});
			
			if (resp.status === 200) {
				return JSON.parse(resp.text);
			}
			return null;
		} catch (error) {
			console.error("Failed to fetch conversation:", error);
			return null;
		}
	}

	// Save a message to conversation
	async saveMessage(conversationId: string, role: "user" | "assistant", content: string): Promise<boolean> {
		if (!this.settings.isAuthenticated) return false;
		
		try {
			const resp = await requestUrl({
				url: this.settings.conversationsEndpoint,
				method: "POST",
				headers: this.buildAuthHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({
					conversationId,
					role,
					content,
					timestamp: new Date().toISOString(),
				}),
			});
			
			return resp.status === 200 || resp.status === 201;
		} catch (error) {
			console.error("Failed to save message:", error);
			return false;
		}
	}

	// Delete a conversation
	async deleteConversation(conversationId: string): Promise<boolean> {
		if (!this.settings.isAuthenticated) return false;
		
		try {
			const resp = await requestUrl({
				url: `${this.settings.conversationsEndpoint}/${conversationId}`,
				method: "DELETE",
				headers: this.buildAuthHeaders({ "Content-Type": "application/json" }),
			});
			
			return resp.status === 200;
		} catch (error) {
			console.error("Failed to delete conversation:", error);
			return false;
		}
	}

	// ============ NOTES API METHODS ============

	// Fetch all notes from cloud
	async fetchCloudNotes(): Promise<NoteData[]> {
		if (!this.settings.isAuthenticated) return [];
		
		try {
			const resp = await requestUrl({
				url: this.settings.notesEndpoint,
				method: "GET",
				headers: this.buildAuthHeaders({ "Content-Type": "application/json" }),
			});
			
			if (resp.status === 200) {
				const data = JSON.parse(resp.text);
				return data.notes || [];
			}
			return [];
		} catch (error) {
			console.error("Failed to fetch cloud notes:", error);
			return [];
		}
	}

	// Delete a note from cloud
	async deleteCloudNote(noteId: string): Promise<boolean> {
		if (!this.settings.isAuthenticated) return false;
		
		try {
			const resp = await requestUrl({
				url: `${this.settings.notesEndpoint}/${noteId}`,
				method: "DELETE",
				headers: this.buildAuthHeaders({ "Content-Type": "application/json" }),
			});
			
			return resp.status === 200;
		} catch (error) {
			console.error("Failed to delete cloud note:", error);
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

	// Auto-scraping method
	private async autoScrapeNote(file: TFile): Promise<void> {
		try {
			// Check if user is authenticated before proceeding
			if (!this.settings.isAuthenticated || !this.settings.authToken) {
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

			// Send to database
			await this.sendToAPI(noteData);
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

	// Public method for syncing a single note (used by Sync All)
	async syncNote(file: TFile): Promise<void> {
		const noteData = await this.extractNoteData(file);
		await this.sendToAPI(noteData);
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
				headers: this.buildAuthHeaders({
					"Content-Type": "application/json",
				}),
				body: JSON.stringify(payload),
			});

			if (resp.status !== 200) {
				throw new Error(`API ${resp.status}: ${resp.text}`);
			}
		} catch (e) {
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

	// Load vault notes into memory for local context (runs on startup)
	private async loadVaultNotesIntoMemory(): Promise<void> {
		if (this.notesLoaded) return;
		
		try {
			const markdownFiles = this.app.vault.getMarkdownFiles();
			
			// Build lightweight index of ALL notes
			for (const file of markdownFiles) {
				try {
					const content = await this.app.vault.read(file);
					const metadata = this.app.metadataCache.getFileCache(file);
					
					const tags: string[] = [];
					if (metadata?.tags) tags.push(...metadata.tags.map(t => t.tag));
					if (metadata?.frontmatter?.tags) {
						const fmTags = Array.isArray(metadata.frontmatter.tags) 
							? metadata.frontmatter.tags 
							: [metadata.frontmatter.tags];
						tags.push(...fmTags);
					}
					
					const headings = metadata?.headings?.map(h => h.heading) || [];
					
					// Clean preview
					const preview = content
						.replace(/^---[\s\S]*?---\n*/m, '')
						.replace(/\n{2,}/g, ' ')
						.substring(0, 200);
					
					this.notesIndex.push({
						path: file.path,
						title: file.basename,
						tags: [...new Set(tags)],
						headings: headings.slice(0, 5),
						preview
					});
				} catch {
					// Skip notes that fail to index
				}
			}
			
			// Also load recent notes fully into memory
			const sortedFiles = markdownFiles
				.sort((a, b) => b.stat.mtime - a.stat.mtime)
				.slice(0, 10);
			
			for (const file of sortedFiles) {
				try {
					const noteData = await this.extractNoteData(file);
					this.allNotesData.push(noteData);
				} catch {
					// Skip notes that fail to load
				}
			}
			
			this.notesLoaded = true;
		} catch {
			// Failed to load vault notes
		}
	}
	
	// Search notes index for relevant notes based on query
	private searchNotesIndex(query: string): Array<{path: string, title: string, score: number}> {
		const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
		const results: Array<{path: string, title: string, score: number}> = [];
		
		for (const note of this.notesIndex) {
			let score = 0;
			const searchText = `${note.title} ${note.tags.join(' ')} ${note.headings.join(' ')} ${note.preview}`.toLowerCase();
			
			for (const word of queryWords) {
				// Title match = high score
				if (note.title.toLowerCase().includes(word)) score += 10;
				// Tag match = high score
				if (note.tags.some(t => t.toLowerCase().includes(word))) score += 8;
				// Heading match = medium score
				if (note.headings.some(h => h.toLowerCase().includes(word))) score += 5;
				// Content match = low score
				if (note.preview.toLowerCase().includes(word)) score += 2;
			}
			
			if (score > 0) {
				results.push({ path: note.path, title: note.title, score });
			}
		}
		
		return results.sort((a, b) => b.score - a.score).slice(0, 5);
	}
	
	// Get current active note
	private async getCurrentNoteContext(): Promise<string> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || activeFile.extension !== 'md') {
			return "";
		}
		
		try {
			const content = await this.app.vault.read(activeFile);
			const metadata = this.app.metadataCache.getFileCache(activeFile);
			
			let context = "\n\n=== CURRENTLY OPEN NOTE ===\n";
			context += `Title: ${activeFile.basename}\n`;
			
			const tags: string[] = [];
			if (metadata?.tags) tags.push(...metadata.tags.map(t => t.tag));
			if (metadata?.frontmatter?.tags) {
				const fmTags = Array.isArray(metadata.frontmatter.tags) 
					? metadata.frontmatter.tags 
					: [metadata.frontmatter.tags];
				tags.push(...fmTags);
			}
			if (tags.length) context += `Tags: ${[...new Set(tags)].join(", ")}\n`;
			
			const cleanContent = content
				.replace(/^---[\s\S]*?---\n*/m, '')
				.replace(/\n{3,}/g, '\n\n')
				.trim();
			
			context += `Content:\n${cleanContent}\n`;
			context += "=== END OF CURRENT NOTE ===\n\n";
			
			return context;
		} catch (err) {
			return "";
		}
	}

	// Get notes directly from vault for immediate context (fallback)
	private async getVaultNotesContext(): Promise<string> {
		// If we already have notes loaded, use them
		if (this.allNotesData.length > 0) {
			return this.buildLocalNotesContext();
		}
		
		// Otherwise, load notes on-demand
		try {
			const markdownFiles = this.app.vault.getMarkdownFiles();
			
			if (markdownFiles.length === 0) {
				return "\n[No markdown notes found in this vault.]\n";
			}
			
			// Get most recent notes
			const sortedFiles = markdownFiles
				.sort((a, b) => b.stat.mtime - a.stat.mtime)
				.slice(0, 10);
			
			let context = "\n\n=== YOUR VAULT NOTES ===\n";
			context += `Found ${markdownFiles.length} notes in vault. Showing ${sortedFiles.length} most recent:\n\n`;
			
			for (let i = 0; i < sortedFiles.length; i++) {
				const file = sortedFiles[i];
				try {
					const content = await this.app.vault.read(file);
					const metadata = this.app.metadataCache.getFileCache(file);
					
					context += `--- Note ${i + 1}: "${file.basename}" ---\n`;
					
					// Tags
					const tags: string[] = [];
					if (metadata?.tags) {
						tags.push(...metadata.tags.map(t => t.tag));
					}
					if (metadata?.frontmatter?.tags) {
						const fmTags = Array.isArray(metadata.frontmatter.tags) 
							? metadata.frontmatter.tags 
							: [metadata.frontmatter.tags];
						tags.push(...fmTags);
					}
					if (tags.length) {
						context += `Tags: ${[...new Set(tags)].join(", ")}\n`;
					}
					
					// Headings
					if (metadata?.headings?.length) {
						context += `Structure: ${metadata.headings.slice(0, 5).map(h => h.heading).join(" > ")}\n`;
					}
					
					// Content
					const cleanContent = content
						.replace(/^---[\s\S]*?---\n*/m, '')
						.replace(/\n{3,}/g, '\n\n')
						.trim();
					
					context += `Content:\n${cleanContent.substring(0, 500)}${cleanContent.length > 500 ? '...' : ''}\n\n`;
					
				} catch (err) {
					console.warn(`Failed to read note: ${file.path}`);
				}
			}
			
			context += "=== END OF VAULT NOTES ===\n\n";
			return context;
			
		} catch (error) {
			console.error("Failed to get vault notes context:", error);
			return "\n[Error loading notes from vault.]\n";
		}
	}

	// Create a new note in the vault
	async createNote(title: string, content: string): Promise<TFile | null> {
		try {
			const fileName = `${title}.md`;
			const file = await this.app.vault.create(fileName, content);
			new Notice(`✅ Created note: ${title}`);
			return file;
		} catch (error) {
			console.error("Failed to create note:", error);
			new Notice(`❌ Failed to create note: ${title}`);
			return null;
		}
	}

	// Get specific notes by @mention
	private async getTaggedNotesContext(message: string): Promise<string> {
		const mentionRegex = /@([\w\s-]+?)(?=\s|$|@)/g;
		const mentions: string[] = [];
		let match;
		
		while ((match = mentionRegex.exec(message)) !== null) {
			mentions.push(match[1].trim());
		}
		
		if (mentions.length === 0) {
			return "";
		}
		
		let context = "\n\n=== SPECIFICALLY REFERENCED NOTES ===\n";
		context += `User mentioned these notes: ${mentions.join(", ")}\n\n`;
		
		for (const mention of mentions) {
			const files = this.app.vault.getMarkdownFiles();
			const matchedFile = files.find(f => 
				f.basename.toLowerCase() === mention.toLowerCase() ||
				f.basename.toLowerCase().includes(mention.toLowerCase())
			);
			
			if (matchedFile) {
				try {
					const content = await this.app.vault.read(matchedFile);
					const metadata = this.app.metadataCache.getFileCache(matchedFile);
					
					context += `--- @${matchedFile.basename} (FULL CONTENT) ---\n`;
					
					// Tags
					const tags: string[] = [];
					if (metadata?.tags) tags.push(...metadata.tags.map(t => t.tag));
					if (metadata?.frontmatter?.tags) {
						const fmTags = Array.isArray(metadata.frontmatter.tags) 
							? metadata.frontmatter.tags 
							: [metadata.frontmatter.tags];
						tags.push(...fmTags);
					}
					if (tags.length) context += `Tags: ${[...new Set(tags)].join(", ")}\n`;
					
					// Full content for tagged notes
					const cleanContent = content
						.replace(/^---[\s\S]*?---\n*/m, '')
						.replace(/\n{3,}/g, '\n\n')
						.trim();
					
					context += `Content:\n${cleanContent}\n\n`;
				} catch (err) {
					context += `--- @${mention} ---\nNote not found or couldn't be read.\n\n`;
				}
			} else {
				context += `--- @${mention} ---\nNo note found with this name.\n\n`;
			}
		}
		
		context += "=== END OF REFERENCED NOTES ===\n\n";
		return context;
	}

	async getChatbotResponse(message: string, conversationHistory: Array<{role: string, content: string}> = []): Promise<string> {
		try {
			// HYBRID CONTEXT BUILDING
			// 1. @mentioned notes (full content) - highest priority
			const taggedNotesContext = await this.getTaggedNotesContext(message);
			
			// 2. Current open note
			const currentNoteContext = await this.getCurrentNoteContext();
			
			// 3. Search-based relevant notes (if no @mentions)
			let searchBasedContext = "";
			if (!taggedNotesContext) {
				const relevantNotes = this.searchNotesIndex(message);
				if (relevantNotes.length > 0) {
					searchBasedContext = "\n\n=== RELEVANT NOTES (based on your question) ===\n";
					for (const result of relevantNotes) {
						const file = this.app.vault.getAbstractFileByPath(result.path);
						if (file instanceof TFile) {
							try {
								const content = await this.app.vault.read(file);
								const cleanContent = content
									.replace(/^---[\s\S]*?---\n*/m, '')
									.replace(/\n{3,}/g, '\n\n')
									.trim();
								searchBasedContext += `--- ${result.title} (relevance: ${result.score}) ---\n`;
								searchBasedContext += `${cleanContent.substring(0, 800)}${cleanContent.length > 800 ? '...' : ''}\n\n`;
							} catch (err) {
								// Skip if can't read
							}
						}
					}
					searchBasedContext += "=== END OF RELEVANT NOTES ===\n\n";
				}
			}
			
			// 4. Recent notes as fallback (if nothing else found)
			let recentNotesContext = "";
			if (!taggedNotesContext && !searchBasedContext && !currentNoteContext) {
				recentNotesContext = await this.getVaultNotesContext();
			}
			
			// Build available notes list for AI awareness
			const availableNotes = this.notesIndex.slice(0, 30).map(n => n.title).join(", ");
			const totalNotes = this.notesIndex.length;

			// Enhanced System Prompt with smart context awareness
			const obsidianSystemPrompt = `You are Athena, a brilliant and friendly AI assistant integrated into Obsidian. You're like a knowledgeable colleague who genuinely wants to help.

## Your Personality
- Warm, approachable, and genuinely helpful
- Confident but not arrogant - you share insights and opinions naturally
- You think step-by-step when solving complex problems
- You're proactive - suggest related ideas the user might not have thought of

## Context Awareness
- The user has ${totalNotes} notes in their vault
- You have access to: ${taggedNotesContext ? '@mentioned notes' : ''} ${currentNoteContext ? 'current open note' : ''} ${searchBasedContext ? 'search-matched notes' : ''} ${recentNotesContext ? 'recent notes' : ''}
- Some available notes: ${availableNotes}${totalNotes > 30 ? '...' : ''}

## IMPORTANT: When You Need More Context
If the user asks about something and you don't have enough information:
1. **Tell them honestly** what notes you DO have access to
2. **Suggest specific notes** they could reference using @NoteName
3. **Ask clarifying questions** like "I can see your recent notes but not one specifically about [topic]. Do you have a note about that? You can reference it with @NoteName"

## Special Features
1. **@NoteName References**: When the user mentions @NoteName, you have the FULL content of that specific note
2. **Note Creation**: If asked to create a note, include at the END:
   \`\`\`
   :::CREATE_NOTE:::
   title: Note Title Here
   content:
   Your note content here...
   :::END_NOTE:::
   \`\`\`

## Response Guidelines
- **Be concise** - Get to the point, but be thorough when complexity demands it
- **Be honest** - If you don't have the right notes, say so and ask for them
- **Use formatting wisely** - Bullet points for lists, bold for emphasis
- **Provide actionable advice** - Help them take next steps

Remember: You're a thinking partner. If you need more context, ASK for it!`;

			// Combine all context sources
			const allNotesContext = taggedNotesContext + currentNoteContext + searchBasedContext + recentNotesContext;

			// Build conversation context for multi-turn awareness
			let conversationContext = "";
			if (conversationHistory.length > 0) {
				const recentHistory = conversationHistory.slice(-6); // Last 3 exchanges
				conversationContext = "\n\n--- Recent Conversation ---\n";
				recentHistory.forEach(msg => {
					const role = msg.role === "user" ? "User" : "Athena";
					conversationContext += `${role}: ${msg.content.substring(0, 300)}${msg.content.length > 300 ? '...' : ''}\n`;
				});
				conversationContext += "--- End of Recent Conversation ---\n";
			}

			// Structured prompt with clear sections
			const enhancedPrompt = `${allNotesContext}${conversationContext}

Current Question: ${message}

Please provide a helpful, thoughtful response.`;

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
				headers: this.buildAuthHeaders({
					"Content-Type": "application/json",
				}),
				body: JSON.stringify({
					hostEmail: this.settings.athenaUsername,
					conversationId: this.conversationId,
					systemPrompt: obsidianSystemPrompt,
					prompt: enhancedPrompt,
					images: [],
					audio: null,
				}),
			});
			
			if (response.status === 200) {
				try {
					const responseText = response.text.trim();
					let aiResponse = "";
					
					try {
						const data = JSON.parse(responseText);
						if (data.response) {
							if (
								typeof data.response === "object" &&
								data.response.stay22LinksOutput
							) {
								aiResponse = data.response.stay22LinksOutput;
							} else {
								aiResponse = data.response;
							}
						} else if (data.message) {
							aiResponse = data.message;
						} else if (data.text) {
							aiResponse = data.text;
						} else if (data.reply) {
							aiResponse = data.reply;
						} else {
							aiResponse = "I'm here to help with your notes!";
						}
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
						aiResponse = jsonObjects.join("\n");
					}
					
					// Check for note creation request in response
					aiResponse = await this.parseAndCreateNotes(aiResponse);
					
					return aiResponse;
				} catch (err) {
					console.error("[Athena Chatbot] JSON parse error:", err);
					return `Error: Response was not valid JSON. Raw response: ${response.text}`;
				}
			} else if (response.status === 401) {
				this.settings.isAuthenticated = false;
				await this.saveSettings();
				return "Authentication expired. Please login again.";
			} else if (response.status === 429 || response.text?.includes("maximum usage limit")) {
				return "⚠️ **Daily message limit reached**\n\nYou've used all your free messages for today.\n\n**Options:**\n- 🔄 Come back in 24 hours for more free messages\n- ⭐ [Subscribe to Pro](https://athenachat.bot/pricing) for unlimited messages";
			} else {
				// Check if response body contains limit message
				try {
					const errorData = JSON.parse(response.text);
					if (errorData.message?.includes("maximum usage limit") || errorData.message?.includes("limit")) {
						return "⚠️ **Daily message limit reached**\n\nYou've used all your free messages for today.\n\n**Options:**\n- 🔄 Come back in 24 hours for more free messages\n- ⭐ [Subscribe to Pro](https://athenachat.bot/pricing) for unlimited messages";
					}
				} catch {
					// Not JSON, continue with generic error
				}
				throw new Error(`API Error: ${response.status}`);
			}
		} catch (error) {
			// Check if error message contains limit info
			if (error instanceof Error && (error.message?.includes("maximum usage limit") || error.message?.includes("limit"))) {
				return "⚠️ **Daily message limit reached**\n\nYou've used all your free messages for today.\n\n**Options:**\n- 🔄 Come back in 24 hours for more free messages\n- ⭐ [Subscribe to Pro](https://athenachat.bot/pricing) for unlimited messages";
			}
			return "Error: Unable to fetch response.";
		}
	}
	
	// Parse AI response for note creation markers and create notes
	private async parseAndCreateNotes(response: string): Promise<string> {
		const notePattern = /:::CREATE_NOTE:::\s*title:\s*(.+?)\s*content:\s*([\s\S]*?):::END_NOTE:::/g;
		let match;
		let cleanResponse = response;
		
		while ((match = notePattern.exec(response)) !== null) {
			const title = match[1].trim();
			const content = match[2].trim();
			
			if (title && content) {
				await this.createNote(title, content);
				// Remove the creation block from response and add confirmation
				cleanResponse = cleanResponse.replace(match[0], `\n\n✅ **Created note:** [[${title}]]\n`);
			}
		}
		
		return cleanResponse;
	}
}

class SettingsModal extends Modal {
	plugin: AthenaPlugin;

	constructor(app: App, plugin_: AthenaPlugin) {
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

		// Auto-scraping toggle
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
						await this.plugin.refreshChatViewIfOpen();
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

		// Auth buttons container
		const authButtonsEl = contentEl.createDiv({ cls: "athena-auth-buttons" });
		authButtonsEl.style.cssText = "display: flex; gap: 10px; margin: 15px 0; flex-wrap: wrap;";

		// Login Button
		const loginButton = authButtonsEl.createEl("button", { text: "Login" });
		loginButton.style.cssText = `
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
				new Notice("Please enter both email and password.");
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

		// Signup Button - redirects to website
		const signupButton = authButtonsEl.createEl("button", { text: "Sign Up" });
		signupButton.style.cssText = `
            padding: 8px 16px; 
            background: var(--background-secondary); 
            color: var(--text-normal); 
            border: 1px solid var(--background-modifier-border); 
            border-radius: 4px; 
            cursor: pointer;
        `;

		signupButton.onclick = () => {
			window.open("https://athenachat.bot/chatbot", "_blank");
			new Notice("Complete signup in browser, then return here to login.");
		};

		// Status indicator
		const statusEl = contentEl.createEl("div", { cls: "athena-status" });
		if (this.plugin.settings.isAuthenticated) {
			statusEl.createEl("p", {
				text: "✅ Authenticated and ready!",
				cls: "athena-status-success",
			});

			// Show auto-scraping status
			const autoScrapeStatus = this.plugin.settings.autoScrapingEnabled
				? "enabled"
				: "disabled";
			statusEl.createEl("p", {
				text: `🔄 Auto-scraping: ${autoScrapeStatus} (${
					this.plugin.settings.autoScrapeDelay / 1000
				}s delay)`,
				cls: "athena-status-info",
			});

			// Action buttons container
			const actionsEl = contentEl.createDiv({ cls: "athena-actions" });
			actionsEl.style.cssText = "display: flex; gap: 10px; margin-top: 15px;";

			// Sync All Notes button
			const syncButton = actionsEl.createEl("button", { text: "Sync All Notes" });
			syncButton.style.cssText = `
				padding: 8px 16px;
				background: var(--interactive-accent);
				color: var(--text-on-accent);
				border: none;
				border-radius: 4px;
				cursor: pointer;
			`;
			syncButton.onclick = async () => {
				syncButton.textContent = "Syncing...";
				syncButton.disabled = true;
				try {
					const files = this.plugin.app.vault.getMarkdownFiles();
					let synced = 0;
					for (const file of files) {
						await this.plugin.syncNote(file);
						synced++;
					}
					new Notice(`✅ Synced ${synced} notes to Athena!`);
				} catch (error) {
					console.error("Sync error:", error);
					new Notice("❌ Sync failed. Check console for details.");
				} finally {
					syncButton.textContent = "Sync All Notes";
					syncButton.disabled = false;
				}
			};

			// Logout button
			const logoutButton = actionsEl.createEl("button", { text: "Logout" });
			logoutButton.style.cssText = `
				padding: 8px 16px;
				background: var(--background-modifier-error);
				color: var(--text-on-accent);
				border: none;
				border-radius: 4px;
				cursor: pointer;
			`;
			logoutButton.onclick = async () => {
				this.plugin.settings.isAuthenticated = false;
				this.plugin.settings.authToken = undefined;
				await this.plugin.saveSettings();
				new Notice("Logged out successfully");
				this.onOpen(); // Refresh modal
			};
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

// Signup Modal
class SignupModal extends Modal {
	plugin: AthenaPlugin;
	onSuccess: () => void;
	private nameInput: HTMLInputElement;
	private emailInput: HTMLInputElement;
	private passwordInput: HTMLInputElement;

	constructor(app: App, plugin: AthenaPlugin, onSuccess: () => void) {
		super(app);
		this.plugin = plugin;
		this.onSuccess = onSuccess;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Create Athena Account" });

		// Name input
		const nameDiv = contentEl.createDiv({ cls: "athena-input-group" });
		nameDiv.createEl("label", { text: "Name" });
		this.nameInput = nameDiv.createEl("input", {
			type: "text",
			placeholder: "Your name",
		});
		this.nameInput.style.cssText = "width: 100%; padding: 8px; margin: 5px 0 15px 0; border-radius: 4px; border: 1px solid var(--background-modifier-border);";

		// Email input
		const emailDiv = contentEl.createDiv({ cls: "athena-input-group" });
		emailDiv.createEl("label", { text: "Email" });
		this.emailInput = emailDiv.createEl("input", {
			type: "email",
			placeholder: "your@email.com",
		});
		this.emailInput.style.cssText = "width: 100%; padding: 8px; margin: 5px 0 15px 0; border-radius: 4px; border: 1px solid var(--background-modifier-border);";

		// Password input
		const passwordDiv = contentEl.createDiv({ cls: "athena-input-group" });
		passwordDiv.createEl("label", { text: "Password" });
		this.passwordInput = passwordDiv.createEl("input", {
			type: "password",
			placeholder: "Choose a password",
		});
		this.passwordInput.style.cssText = "width: 100%; padding: 8px; margin: 5px 0 15px 0; border-radius: 4px; border: 1px solid var(--background-modifier-border);";

		// Signup button
		const signupBtn = contentEl.createEl("button", { text: "Create Account" });
		signupBtn.style.cssText = `
			width: 100%;
			padding: 10px;
			background: var(--interactive-accent);
			color: var(--text-on-accent);
			border: none;
			border-radius: 4px;
			cursor: pointer;
			margin-top: 10px;
		`;

		signupBtn.onclick = async () => {
			const name = this.nameInput.value.trim();
			const email = this.emailInput.value.trim();
			const password = this.passwordInput.value;

			if (!name || !email || !password) {
				new Notice("Please fill in all fields.");
				return;
			}

			signupBtn.textContent = "Creating account...";
			signupBtn.disabled = true;

			try {
				const resp = await requestUrl({
					url: this.plugin.settings.signupEndpoint,
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name, email, password }),
				});

				if (resp.status === 200 || resp.status === 201) {
					new Notice("Account created! You can now login.");
					this.plugin.settings.athenaUsername = email;
					await this.plugin.saveSettings();
					this.close();
					this.onSuccess();
				} else {
					const data = JSON.parse(resp.text);
					new Notice(data.message || "Signup failed. Please try again.");
				}
			} catch (error) {
				console.error("Signup error:", error);
				new Notice("Signup failed. Please try again.");
			} finally {
				signupBtn.textContent = "Create Account";
				signupBtn.disabled = false;
			}
		};
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}


