import {
	Plugin,
	Notice,
	TFile,
	TFolder,
	CachedMetadata,
	Setting,
	App,
	Modal,
	requestUrl,
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	Component,
	setIcon,
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
	subscriptionEndpoint: string;
	messagesCountEndpoint: string;
	isAuthenticated: boolean;
	authToken?: string;
	autoScrapingEnabled: boolean;
	autoScrapeDelay: number;
	// Subscription & usage (from backend)
	isPremiumUser: boolean;
	messagesUsed: number;
	lastUsageCheck: string; // ISO date string
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
		subscriptionEndpoint: `${normalizedBase}/chatbot/subscription`,
		messagesCountEndpoint: `${normalizedBase}/chatbot/messagescount`,
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
	isPremiumUser: false,
	messagesUsed: 0,
	lastUsageCheck: "",
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

// Removed unused AuthResponse interface

interface CloudNoteSummary {
	title: string;
	tags?: string[];
	content?: string;
}

interface PendingConfirmation {
	action: string;
	params: Record<string, unknown>;
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
	
	// Context Management System - Optimized for 200k tokens
	private readonly MAX_MESSAGES_BEFORE_SUMMARY = 15; // Messages before summarization
	private readonly MAX_CONVERSATION_MESSAGES = 100; // Hard limit before forcing new chat
	private conversationSummary: string = ""; // Rolling summary of older messages
	private summaryCyclesRemaining = 15; // Decreases: 15, 14, 13... until context full
	private isContextFull = false;
	private pendingConfirmations: Map<string, PendingConfirmation> = new Map();
	private toggleVisibility(element: HTMLElement, visible: boolean): void {
		element.toggleClass("athena-hidden", !visible);
	}

	private renderAthenaAvatar(target: HTMLElement): void {
		target.empty();
		const avatar = target.createEl("img", {
			attr: {
				src: "https://athenachat.bot/assets/athena/logo.png",
				alt: "Athena",
			},
		});
		avatar.addEventListener("error", () => avatar.detach());
	}

	private formatTimestamp(value?: string | Date): string {
		if (value instanceof Date) {
			return value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		}
		if (typeof value === "string") {
			const parsed = new Date(value);
			if (!Number.isNaN(parsed.getTime())) {
				return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			}
		}
		return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	private async copyToClipboard(
		text: string,
		button: HTMLButtonElement,
		onReset: () => void
	): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			button.empty();
			setIcon(button, "check");
			button.setAttr("aria-label", "Copied");
			button.setAttr("title", "Copied");
		} catch (error) {
			console.error("Failed to copy message", error);
			new Notice("Unable to copy message to clipboard");
		} finally {
			window.setTimeout(() => {
				onReset();
			}, 1200);
		}
	}

	private addMessageActions(
		target: HTMLElement,
		options: {
			copyText: string;
			copyLabel?: string;
			timestamp?: string | Date;
			onRetry?: () => void;
			showAddToNote?: boolean;
		}
	): void {
		const row = target.createDiv({ cls: "athena-message-actions" });
		const copyLabel = options.copyLabel ?? "Copy response";
		const copyBtn = row.createEl("button", {
			cls: "athena-action-btn",
		});
		const applyCopyIcon = () => {
			copyBtn.empty();
			setIcon(copyBtn, "copy");
			copyBtn.setAttr("aria-label", copyLabel);
			copyBtn.setAttr("title", copyLabel);
		};
		applyCopyIcon();
		copyBtn.onclick = () => {
			void this.copyToClipboard(options.copyText, copyBtn, applyCopyIcon);
		};

		// Add to Notes button (for assistant messages)
		if (options.showAddToNote !== false) {
			const addToNoteBtn = row.createEl("button", {
				cls: "athena-action-btn",
			});
			setIcon(addToNoteBtn, "file-plus");
			addToNoteBtn.setAttr("aria-label", "Add to current note");
			addToNoteBtn.setAttr("title", "Add to current note");
			addToNoteBtn.onclick = async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile || activeFile.extension !== "md") {
					new Notice("No note open - please open a note first");
					return;
				}
				try {
					const existingContent = await this.app.vault.read(activeFile);
					await this.app.vault.modify(activeFile, existingContent + "\n\n" + options.copyText);
					new Notice(`Added to ${activeFile.basename}`);
					// Visual feedback
					addToNoteBtn.empty();
					setIcon(addToNoteBtn, "check");
					window.setTimeout(() => {
						addToNoteBtn.empty();
						setIcon(addToNoteBtn, "file-plus");
					}, 1200);
				} catch {
					new Notice("Failed to add to note");
				}
			};
		}

		if (options.onRetry) {
			const retryBtn = row.createEl("button", {
				cls: "athena-action-btn",
			});
			setIcon(retryBtn, "refresh-ccw");
			retryBtn.setAttr("aria-label", "Retry response");
			retryBtn.setAttr("title", "Retry response");
			retryBtn.onclick = options.onRetry;
		}

		row.createEl("span", {
			cls: "athena-message-time",
			text: this.formatTimestamp(options.timestamp),
		});
	}

	private confirmAction(message: string, confirmLabel = "Confirm"): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new AthenaConfirmModal(this.app, message, confirmLabel, resolve);
			modal.open();
		});
	}

	public getConversationSummary(): string {
		return this.conversationSummary;
	}

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
			text: "Your AI knowledge assistant",
			cls: "athena-chatbot-subtitle",
		});

		// Header actions (history + new chat + settings)
		const headerActions = headerDiv.createDiv({ cls: "athena-header-actions" });
		
		// History button
		const historyBtn = headerActions.createEl("button", {
			cls: "athena-icon-btn",
			attr: { title: "Chat history" },
		});
		setIcon(historyBtn, "history");
		
		// New chat button
		const newChatBtn = headerActions.createEl("button", {
			cls: "athena-icon-btn athena-new-chat-btn",
			attr: { title: "New chat" },
		});
		setIcon(newChatBtn, "plus");
		
		// Settings button
		const settingsBtn = headerActions.createEl("button", {
			cls: "athena-icon-btn",
			attr: { title: "Settings" },
		});
		setIcon(settingsBtn, "settings");
		
		newChatBtn.onclick = () => {
			this.conversationHistory = [];
			this.currentConversationId = null;
			this.conversationSummary = "";
			this.summaryCyclesRemaining = 15;
			this.isContextFull = false;
			this.showSettings = false;
			void this.refreshView();
		};
		
		settingsBtn.onclick = () => {
			this.showSettings = !this.showSettings;
			void this.refreshView();
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
		this.toggleVisibility(historySidebar, this.showHistorySidebar);
		
		const sidebarHeader = historySidebar.createDiv({ cls: "athena-sidebar-header" });
		sidebarHeader.createEl("h3", { text: "Chat history", cls: "athena-sidebar-title" });
		const closeSidebarBtn = sidebarHeader.createEl("button", { cls: "athena-close-sidebar-btn", text: "×" });
		closeSidebarBtn.onclick = () => {
			this.showHistorySidebar = false;
			this.toggleVisibility(historySidebar, false);
		};
		
		const conversationsList = historySidebar.createDiv({ cls: "athena-conversations-list" });
		
		// Load conversations
		await this.loadConversationsList(conversationsList, historySidebar);
		
		// Toggle sidebar on history button click
		historyBtn.onclick = () => {
			this.showHistorySidebar = !this.showHistorySidebar;
			this.toggleVisibility(historySidebar, this.showHistorySidebar);
			if (this.showHistorySidebar) {
				void this.loadConversationsList(conversationsList, historySidebar);
			}
		};

		// Main chat container
		const chatContainer = mainLayout.createDiv({ cls: "athena-chat-container" });
		
		// Chat messages area
		const chatLog = chatContainer.createEl("div", { cls: "athena-chat-log" });
		
		// Welcome message
		const welcomeMsg = chatLog.createDiv({ cls: "athena-welcome-message" });
		welcomeMsg.createEl("div", { cls: "athena-welcome-icon", text: "✨" });
		welcomeMsg.createEl("h4", { text: "What can I help you with today", cls: "athena-welcome-title" });
		welcomeMsg.createEl("p", { 
			text: "Ask me anything about your notes, or let me help you brainstorm ideas",
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
		helpTip.createSpan({ cls: "athena-help-icon", text: "💡" });
		helpTip.createEl("strong", { text: "Tip:" });
		helpTip.createSpan({
			text: " Use ",
		});
		const code = helpTip.createEl("code", { text: "@NoteName" });
		code.setAttr("aria-label", "note reference shorthand");
		helpTip.createSpan({
			text: " to reference notes or ask me to create new ones.",
		});

		// Input area
		const inputContainer = chatContainer.createDiv({ cls: "athena-input-container" });
		
		// Show remaining messages or premium status
		const remainingCount = this.plugin.getRemainingMessages();
		const messagesCounter = inputContainer.createDiv({ cls: "athena-messages-counter" });
		if (remainingCount === -1) {
			messagesCounter.textContent = "⭐ Pro - unlimited messages";
			messagesCounter.addClass("athena-counter-premium");
		} else {
			messagesCounter.textContent = `${remainingCount} messages left today`;
			if (remainingCount <= 3) {
				messagesCounter.addClass("athena-counter-low");
			}
		}
		
		// Note autocomplete dropdown
		const autocompleteDropdown = inputContainer.createDiv({ cls: "athena-autocomplete-dropdown athena-hidden" });
		
		const inputWrapper = inputContainer.createDiv({ cls: "athena-input-wrapper" });
		const chatInput = inputWrapper.createEl("textarea", {
			cls: "athena-chat-input",
			attr: { placeholder: "Ask anything... use @NoteName to reference notes", rows: "1" }
		});
		
		const buttonContainer = inputWrapper.createDiv({ cls: "athena-btn-container" });
		
		const sendButton = buttonContainer.createEl("button", {
			cls: "athena-send-btn",
		});
		setIcon(sendButton, "send");
		
		// Stop button (hidden by default)
		const stopButton = buttonContainer.createEl("button", {
			cls: "athena-stop-btn",
		});
		setIcon(stopButton, "square");
		stopButton.addClass("athena-hidden");

		// Auto-resize textarea
		chatInput.addEventListener("input", () => {
			chatInput.setCssProps({ height: "auto" });
			const nextHeight = Math.min(chatInput.scrollHeight, 120);
			chatInput.setCssProps({ height: `${nextHeight}px` });
			
			// Check for @ mention
			this.handleNoteMention(chatInput, autocompleteDropdown);
		});

		// Add Enter key support
		chatInput.addEventListener("keydown", (e) => {
			// Handle autocomplete navigation
			if (!autocompleteDropdown.hasClass("athena-hidden")) {
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
					this.toggleVisibility(autocompleteDropdown, false);
					return;
				}
			}
			
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				sendButton.click();
			}
		});

		// Track if we're waiting for response
		let isWaitingForResponse = false;
		let abortController: AbortController | null = null;

		// Stop button handler
		stopButton.onclick = () => {
			if (abortController) {
				abortController.abort();
				abortController = null;
			}
			isWaitingForResponse = false;
			chatInput.disabled = false;
			this.toggleVisibility(sendButton, true);
			this.toggleVisibility(stopButton, false);
			chatInput.focus();
			new Notice("Response stopped");
		};

		sendButton.onclick = async () => {
			const userMessage = chatInput.value.trim();
			if (!userMessage) return;

			// Prevent sending while waiting for response
			if (isWaitingForResponse) {
				return;
			}

			// Check daily message limit
			const dailyLimit = this.plugin.checkDailyLimit();
			if (!dailyLimit.allowed) {
				const limitMsg = chatLog.createDiv({ cls: "athena-limit-message" });
				limitMsg.createDiv({ cls: "athena-limit-icon", text: "⏰" });
				const limitText = limitMsg.createDiv({ cls: "athena-limit-text" });
				limitText.createEl("strong", { text: "Daily limit reached" });
				const limitParagraph = limitText.createEl("p");
				limitParagraph.appendText("You've used all 10 free messages today. Come back tomorrow or ");
				const upgradeLink = limitParagraph.createEl("a", {
					text: "upgrade to pro",
					href: "https://athenachat.bot/",
				});
				upgradeLink.setAttr("target", "_blank");
				upgradeLink.setAttr("rel", "noreferrer");
				limitParagraph.appendText(" for unlimited messages.");
				chatLog.scrollTop = chatLog.scrollHeight;
				new Notice("Daily message limit reached");
				return;
			}

			// Check if context is full - auto-start new chat with summary
			if (this.isContextFull || this.conversationHistory.length >= this.MAX_CONVERSATION_MESSAGES) {
				// Auto-create new chat with summary carried over
				const summary = this.conversationSummary || this.generateQuickSummary();
				this.conversationHistory = [];
				this.currentConversationId = null;
				this.conversationSummary = `[Previous conversation summary: ${summary}]`;
				this.summaryCyclesRemaining = 15;
				this.isContextFull = false;
				
				const infoMsg = chatLog.createDiv({ cls: "athena-info-message" });
				infoMsg.createDiv({ cls: "athena-info-icon", text: "🔄" });
				const infoText = infoMsg.createDiv({ cls: "athena-info-text" });
				infoText.createEl("strong", { text: "New conversation started" });
				infoText.createEl("p", {
					text: "Context was getting full, so I started a fresh conversation and kept your previous summary",
				});
				chatLog.scrollTop = chatLog.scrollHeight;
			}
			
			// Check if we need to summarize (every 15 messages)
			if (this.conversationHistory.length > 0 && 
				this.conversationHistory.length % this.MAX_MESSAGES_BEFORE_SUMMARY === 0) {
				this.summarizeOlderMessages();
			}

			// Block input while waiting and show stop button
			isWaitingForResponse = true;
			abortController = new AbortController();
			chatInput.disabled = true;
			this.toggleVisibility(sendButton, false);
			this.toggleVisibility(stopButton, true);

			// Create conversation ID if new chat
			if (!this.currentConversationId) {
				this.currentConversationId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
			}

			// Hide welcome message on first interaction
			if (!welcomeMsg.hasClass("athena-hidden")) {
				welcomeMsg.addClass("athena-hidden");
			}

			// Add user message to chat
			const userTimestamp = new Date();
			const userMsgContainer = chatLog.createDiv({ cls: "athena-message-row athena-user-row" });
			const userMessageEl = userMsgContainer.createDiv({ cls: "athena-message athena-user-message" });
			userMessageEl.createEl("p", { text: userMessage });
			this.addMessageActions(userMessageEl, {
				copyText: userMessage,
				copyLabel: "Copy question",
				timestamp: userTimestamp,
				showAddToNote: false,
			});

			chatInput.value = "";
			chatInput.setCssProps({ height: "auto" });

			// Save user message to cloud
			await this.plugin.saveMessage(this.currentConversationId, "user", userMessage);

			// Add bot thinking message with typing indicator
			const botMsgContainer = chatLog.createDiv({ cls: "athena-message-row athena-bot-row" });
			const botAvatar = botMsgContainer.createDiv({ cls: "athena-bot-avatar" });
			this.renderAthenaAvatar(botAvatar);
			
			const botMessageEl = botMsgContainer.createDiv({ cls: "athena-message athena-bot-message" });
			const typingIndicator = botMessageEl.createDiv({ cls: "athena-typing-indicator" });
			for (let i = 0; i < 3; i++) {
				typingIndicator.createSpan();
			}

			// Scroll to bottom
			chatLog.scrollTop = chatLog.scrollHeight;

			// Store user message in history
			this.conversationHistory.push({ role: "user", content: userMessage });

			try {
				const response = await this.plugin.getChatbotResponse(
					userMessage,
					this.conversationHistory
				);

				// Refresh usage count from backend
				await this.plugin.refreshUsage();
				
				// Update counter display
				const newRemaining = this.plugin.getRemainingMessages();
				if (newRemaining === -1) {
					// Premium user - don't update counter
				} else {
					messagesCounter.textContent = `${newRemaining} messages left today`;
					messagesCounter.removeClass("athena-counter-low", "athena-counter-premium");
					if (newRemaining <= 3) {
						messagesCounter.addClass("athena-counter-low");
					}
				}

				// Store assistant response in history
				this.conversationHistory.push({ role: "assistant", content: response });
				
				// Save assistant response to cloud
				await this.plugin.saveMessage(this.currentConversationId, "assistant", response);

				// Clear typing indicator
				typingIndicator.remove();

				// Create a component for proper cleanup
				const component = new Component();

				try {
					// Use Obsidian's MarkdownRenderer properly
					await MarkdownRenderer.render(
						this.app,
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
					// Fallback to showing plain text
					botMessageEl.setText(response);
				}
				
				this.addMessageActions(botMessageEl, {
					copyText: response,
					timestamp: new Date(),
					onRetry: () => {
						if (
							this.conversationHistory.length > 0 &&
							this.conversationHistory[this.conversationHistory.length - 1].role === "assistant"
						) {
							this.conversationHistory.pop();
						}
						botMsgContainer.remove();
						chatInput.value = userMessage;
						sendButton.click();
					},
				});
				
			} catch (error) {
				typingIndicator.remove();
				// Check if it was aborted by user
				if (error instanceof Error && error.name === "AbortError") {
					botMessageEl.createEl("p", { 
						text: "Response stopped by user",
						cls: "athena-info-text"
					});
				} else {
					botMessageEl.createEl("p", { 
						text: "Sorry, I couldn't process that request. Please try again",
						cls: "athena-error-text"
					});
				}
			} finally {
				// Re-enable input after response (success or error)
				isWaitingForResponse = false;
				abortController = null;
				chatInput.disabled = false;
				this.toggleVisibility(sendButton, true);
				this.toggleVisibility(stopButton, false);
				chatInput.focus();
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
				this.toggleVisibility(dropdown, true);
				
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
						this.toggleVisibility(dropdown, false);
					};
				});
			} else {
				this.toggleVisibility(dropdown, false);
			}
		} else {
			this.toggleVisibility(dropdown, false);
		}
	}

	// Generate a quick summary of the conversation for context carryover
	private generateQuickSummary(): string {
		if (this.conversationHistory.length === 0) return "";
		
		// Get key topics from recent messages
		const topics: string[] = [];
		const actions: string[] = [];
		const recentMessages = this.conversationHistory.slice(-10);
		
		for (const msg of recentMessages) {
			// Extract @mentions and [[wikilinks]]
			const mentions = msg.content.match(/@[\w\s-]+|\[\[[\w\s-]+\]\]/g);
			if (mentions) topics.push(...mentions);
			
			// Extract actions performed
			if (msg.role === "assistant") {
				const actionMatches = msg.content.match(/✅|📁|📦|📝|🗑️|✏️|Created|Moved|Deleted|Renamed|Added to/g);
				if (actionMatches) {
					actions.push(...actionMatches);
				}
			}
			
			// Extract key phrases (questions, commands)
			if (msg.role === "user") {
				const firstLine = msg.content.split('\n')[0].substring(0, 100);
				topics.push(firstLine);
			}
		}
		
		let summary = "";
		if (topics.length > 0) {
			summary += `Topics discussed: ${topics.slice(0, 5).join(", ")}`;
		}
		if (actions.length > 0) {
			summary += ` | Actions: ${actions.slice(0, 5).join(", ")}`;
		}
		
		return summary || "General conversation about notes";
	}

	// Summarize older messages to save context space
	private summarizeOlderMessages(): void {
		if (this.conversationHistory.length < this.MAX_MESSAGES_BEFORE_SUMMARY) return;
		
		// Keep last 15 messages in full, summarize the rest
		const toSummarize = this.conversationHistory.slice(0, -this.MAX_MESSAGES_BEFORE_SUMMARY);
		const toKeep = this.conversationHistory.slice(-this.MAX_MESSAGES_BEFORE_SUMMARY);
		
		// Build detailed summary from older messages
		const summaryParts: string[] = [];
		const notesDiscussed = new Set<string>();
		const actionsPerformed: string[] = [];
		
		for (const msg of toSummarize) {
			if (msg.role === "user") {
				// Extract note mentions
				const mentions = msg.content.match(/@[\w\s-]+|\[\[[\w\s-]+\]\]/g);
				if (mentions) {
					mentions.forEach(m => notesDiscussed.add(m));
				}
				// Add user question summary
				const firstLine = msg.content.split('\n')[0].substring(0, 100);
				summaryParts.push(`Q: ${firstLine}`);
			} else {
				// Extract key actions from assistant responses
				const actions = msg.content.match(/✅ Created note: \[\[([^\]]+)\]\]|📦 Moved: ([^→]+) → ([^\n]+)|🗑️ Deleted: ([^\n]+)|✏️ Renamed: ([^→]+) → ([^\n]+)|📝 Added to: \[\[([^\]]+)\]\]/g);
				if (actions) {
					actionsPerformed.push(...actions);
				}
			}
		}
		
		// Build structured summary
		let newSummary = "";
		if (notesDiscussed.size > 0) {
			newSummary += `Notes discussed: ${Array.from(notesDiscussed).slice(0, 10).join(", ")}. `;
		}
		if (actionsPerformed.length > 0) {
			newSummary += `Actions: ${actionsPerformed.slice(0, 10).join("; ")}. `;
		}
		if (summaryParts.length > 0) {
			newSummary += `Key questions: ${summaryParts.slice(0, 5).join(" | ")}`;
		}
		
		// Append to existing summary
		this.conversationSummary = this.conversationSummary 
			? `${this.conversationSummary} || ${newSummary}`
			: newSummary;
		
		// Trim summary if too long (keep most recent 3000 chars)
		if (this.conversationSummary.length > 3000) {
			this.conversationSummary = "..." + this.conversationSummary.substring(this.conversationSummary.length - 3000);
		}
		
		// Replace history with summarized + recent
		this.conversationHistory = toKeep;
		
		// Decrease cycles remaining
		this.summaryCyclesRemaining--;
		if (this.summaryCyclesRemaining <= 0) {
			this.isContextFull = true;
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
		const loginBtn = form.createEl("button", { text: "Sign in", cls: "athena-btn-primary" });
		
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
				new Notice("Signed in successfully");
				await this.refreshView();
			} else {
				new Notice("Sign in failed. Check your credentials");
				loginBtn.textContent = "Sign in";
				loginBtn.disabled = false;
			}
		};

		// Signup link
		const footer = loginPanel.createDiv({ cls: "athena-login-footer" });
		footer.createSpan({ text: "Don't have an account? " });
		const signupLink = footer.createEl("a", {
			text: "Create one free",
			href: "https://athenachat.bot/chatbot",
		});
		signupLink.setAttr("target", "_blank");
		signupLink.setAttr("rel", "noreferrer");
	}

	// Render settings panel
	private renderSettingsPanel(container: Element): void {
		const panel = (container as HTMLElement).createDiv({ cls: "athena-settings-view" });
		
		// Header with back button
		const header = panel.createDiv({ cls: "athena-settings-header" });
		const backBtn = header.createEl("button", { cls: "athena-back-button" });
		setIcon(backBtn, "arrow-left");
		backBtn.onclick = () => {
			this.showSettings = false;
			void this.refreshView();
		};
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
			
			// Show subscription status
			const isPremium = this.plugin.settings.isPremiumUser;
			const statusEl = details.createEl("span", { 
				text: isPremium ? "⭐ Pro plan" : "Free plan", 
				cls: isPremium ? "athena-user-status athena-status-premium" : "athena-user-status" 
			});
			
			const logoutBtn = accountCard.createEl("button", { text: "Sign out", cls: "athena-btn-outline-danger" });
			logoutBtn.onclick = async () => {
				this.plugin.settings.isAuthenticated = false;
				this.plugin.settings.authToken = undefined;
				await this.plugin.saveSettings();
				new Notice("Signed out");
				this.showSettings = false;
				await this.refreshView();
			};
		} else {
			accountCard.createEl("p", { text: "Not signed in", cls: "athena-text-muted" });
			const signInBtn = accountCard.createEl("button", { text: "Sign in", cls: "athena-btn-primary" });
			signInBtn.onclick = () => {
				this.showSettings = false;
				void this.refreshView();
			};
		}

		// Sync Card
		const syncCard = content.createDiv({ cls: "athena-card" });
		syncCard.createEl("h3", { text: "Note sync", cls: "athena-card-title" });
		
		const syncRow = syncCard.createDiv({ cls: "athena-setting-row" });
		const syncLabel = syncRow.createDiv({ cls: "athena-setting-label" });
		syncLabel.createEl("span", { text: "Auto-sync notes", cls: "athena-setting-name" });
		syncLabel.createEl("span", { text: "Sync notes to cloud so AI can access them across devices", cls: "athena-setting-desc" });
		
		// Custom toggle button instead of checkbox
		const toggleBtn = syncRow.createEl("button", { cls: "athena-toggle-btn" });
		toggleBtn.addClass(this.plugin.settings.autoScrapingEnabled ? "athena-toggle-on" : "athena-toggle-off");
		toggleBtn.textContent = this.plugin.settings.autoScrapingEnabled ? "On" : "Off";
		
		toggleBtn.onclick = async () => {
			this.plugin.settings.autoScrapingEnabled = !this.plugin.settings.autoScrapingEnabled;
			await this.plugin.saveSettings();
			toggleBtn.textContent = this.plugin.settings.autoScrapingEnabled ? "On" : "Off";
			toggleBtn.removeClass("athena-toggle-on", "athena-toggle-off");
			toggleBtn.addClass(this.plugin.settings.autoScrapingEnabled ? "athena-toggle-on" : "athena-toggle-off");
			new Notice(this.plugin.settings.autoScrapingEnabled ? "Auto-sync enabled" : "Auto-sync disabled");
		};

		if (this.plugin.settings.isAuthenticated) {
			const syncBtn = syncCard.createEl("button", { text: "Sync all notes now", cls: "athena-btn-secondary" });
			syncBtn.onclick = async () => {
				syncBtn.textContent = "Syncing...";
				syncBtn.disabled = true;
				try {
					const files = this.plugin.app.vault.getMarkdownFiles();
					for (const file of files) {
						await this.plugin.syncNote(file);
					}
					new Notice(`Synced ${files.length} notes`);
				} catch (e) {
					new Notice("Sync failed");
				}
				syncBtn.textContent = "Sync all notes now";
				syncBtn.disabled = false;
			};
		}

		// Usage Limits Card
		const limitsCard = content.createDiv({ cls: "athena-card" });
		limitsCard.createEl("h3", { text: "Usage", cls: "athena-card-title" });
		const limitsInfo = limitsCard.createDiv({ cls: "athena-limits-info" });
		
		if (this.plugin.settings.isPremiumUser) {
			limitsInfo.createEl("p", { text: "Pro plan - unlimited messages", cls: "athena-text-premium" });
			limitsInfo.createEl("p", { text: "Thank you for supporting Athena", cls: "athena-text-muted" });
		} else {
			const remaining = this.plugin.getRemainingMessages();
			limitsInfo.createEl("p", { text: `${remaining}/9 messages remaining`, cls: "athena-text-muted" });
			limitsInfo.createEl("p", { text: "Upgrade for unlimited messages", cls: "athena-text-muted" });
			limitsCard.createEl("a", { 
				text: "Upgrade to pro →", 
				href: "https://athenachat.bot/", 
				cls: "athena-link athena-upgrade-link" 
			});
		}

		// About Card
		const aboutCard = content.createDiv({ cls: "athena-card" });
		aboutCard.createEl("h3", { text: "About", cls: "athena-card-title" });
		aboutCard.createEl("p", { text: "Athena AI - your intelligent note assistant powered by AI", cls: "athena-text-muted" });
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
					this.toggleVisibility(sidebar, false);
					this.showHistorySidebar = false;
				};
				
				// Delete button
				const deleteBtn = convItem.createEl("button", { cls: "athena-conv-delete", text: "×" });
				deleteBtn.onclick = async (e) => {
					e.stopPropagation();
					const confirmed = await this.confirmAction("Delete this conversation?", "Delete");
					if (confirmed) {
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
			(welcomeMsg as HTMLElement).addClass("athena-hidden");
			
			for (const msg of conversation.messages) {
				if (msg.role === "user") {
					const userMsgContainer = chatLog.createDiv({ cls: "athena-message-row athena-user-row" });
					const userMessageEl = userMsgContainer.createDiv({ cls: "athena-message athena-user-message" });
					userMessageEl.createEl("p", { text: msg.content });
					this.addMessageActions(userMessageEl, {
						copyText: msg.content,
						copyLabel: "Copy question",
						timestamp: msg.timestamp,
						showAddToNote: false,
					});
				} else {
					const botMsgContainer = chatLog.createDiv({ cls: "athena-message-row athena-bot-row" });
					const botAvatar = botMsgContainer.createDiv({ cls: "athena-bot-avatar" });
					this.renderAthenaAvatar(botAvatar);
					const botMessageEl = botMsgContainer.createDiv({ cls: "athena-message athena-bot-message" });
					
					const component = new Component();
					try {
						await MarkdownRenderer.render(this.app, msg.content, botMessageEl, "", component);
						component.load();
					} catch {
						botMessageEl.setText(msg.content);
					}
					this.addMessageActions(botMessageEl, {
						copyText: msg.content,
						timestamp: msg.timestamp,
					});
				}
			}
		}
	}

	async onClose(): Promise<void> {
		// Cleanup if needed
	}
}

class AthenaConfirmModal extends Modal {
	private message: string;
	private confirmLabel: string;
	private onResult: (result: boolean) => void;

	constructor(app: App, message: string, confirmLabel: string, onResult: (result: boolean) => void) {
		super(app);
		this.message = message;
		this.confirmLabel = confirmLabel;
		this.onResult = onResult;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", { text: this.message });
		const buttonRow = contentEl.createDiv({ cls: "athena-confirm-buttons" });
		const confirmBtn = buttonRow.createEl("button", {
			text: this.confirmLabel,
			cls: "mod-cta",
		});
		const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
		confirmBtn.onclick = () => {
			this.close();
			this.onResult(true);
		};
		cancelBtn.onclick = () => {
			this.close();
			this.onResult(false);
		};
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export default class AthenaPlugin extends Plugin {

	// Check subscription status and usage from API
	async checkSubscription(): Promise<boolean> {
		if (!this.settings.athenaUsername) return false;
		
		// Cache check for 5 minutes
		const now = new Date().toISOString();
		const lastCheck = this.settings.lastUsageCheck;
		if (lastCheck) {
			const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
			if (lastCheck > fiveMinAgo) {
				return this.settings.isPremiumUser;
			}
		}
		
		try {
			// Fetch subscription status
			const subResp = await requestUrl({
				url: `${this.settings.subscriptionEndpoint}?email=${encodeURIComponent(this.settings.athenaUsername)}`,
				method: "GET",
			});
			
			if (subResp.status === 200) {
				const subData = JSON.parse(subResp.text);
				// Check isPremiumPlan OR if subscription exists with active/trialing status
				const hasActiveSubscription = subData.subscription && 
					(subData.subscription.status === "active" || subData.subscription.status === "trialing");
				this.settings.isPremiumUser = subData.isPremiumPlan === true || hasActiveSubscription;
			}
			
			// Fetch messages count
			const countResp = await requestUrl({
				url: `${this.settings.messagesCountEndpoint}?email=${encodeURIComponent(this.settings.athenaUsername)}`,
				method: "GET",
			});
			
			if (countResp.status === 200) {
				const countData = JSON.parse(countResp.text);
				this.settings.messagesUsed = countData.messagesCount || 0;
			}
			
			this.settings.lastUsageCheck = now;
			await this.saveSettings();
		} catch {
			// If check fails, use cached values
		}
		return this.settings.isPremiumUser;
	}

	// Check if user is premium (cached)
	isPremium(): boolean {
		return this.settings.isPremiumUser;
	}

	// Fetch message count from backend
	async fetchMessagesCount(): Promise<number> {
		if (!this.settings.athenaUsername) return 0;
		
		try {
			const resp = await requestUrl({
				url: `${this.settings.messagesCountEndpoint}?email=${encodeURIComponent(this.settings.athenaUsername)}`,
				method: "GET",
			});
			
			if (resp.status === 200) {
				const data = JSON.parse(resp.text);
				this.settings.messagesUsed = data.messagesCount || 0;
				this.settings.lastUsageCheck = new Date().toISOString();
				await this.saveSettings();
				return this.settings.messagesUsed;
			}
		} catch {
			// Use cached value on error
		}
		return this.settings.messagesUsed;
	}

	// Check usage limit (uses backend data)
	checkDailyLimit(): { allowed: boolean; remaining: number } {
		// Premium users have unlimited messages
		if (this.settings.isPremiumUser) {
			return { allowed: true, remaining: -1 }; // -1 = unlimited
		}
		
		// Free users: limit is 9 messages (backend blocks at 9)
		const FREE_LIMIT = 9;
		const remaining = Math.max(0, FREE_LIMIT - this.settings.messagesUsed);
		return {
			allowed: this.settings.messagesUsed < FREE_LIMIT,
			remaining
		};
	}

	// Refresh usage from backend after sending message
	async refreshUsage(): Promise<void> {
		await this.fetchMessagesCount();
	}

	// Get remaining messages for display
	getRemainingMessages(): number {
		// Premium users have unlimited
		if (this.settings.isPremiumUser) {
			return -1; // -1 means unlimited
		}
		const FREE_LIMIT = 9;
		return Math.max(0, FREE_LIMIT - this.settings.messagesUsed);
	}

	// Build context from locally scraped notes - optimized for token efficiency
	private buildLocalNotesContext(): string {
		if (!this.allNotesData.length) {
			return "";
		}

		// Get most recent 5 notes only
		const sortedNotes = [...this.allNotesData]
			.sort((a, b) => b.modified - a.modified)
			.slice(0, 5);

		let context = "\n\n=== RECENT NOTES ===\n";

		sortedNotes.forEach((note) => {
			context += `--- ${note.title} ---\n`;
			
			// Clean and truncate content
			const cleanContent = note.content
				.replace(/^---[\s\S]*?---\n*/m, '')
				.replace(/\n{3,}/g, '\n\n')
				.trim();
			
			context += `${cleanContent.substring(0, 300)}${cleanContent.length > 300 ? '...' : ''}\n\n`;
		});

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
				const notes = JSON.parse(response.text) as CloudNoteSummary[];
				
				let context = "\n\n=== USER'S CLOUD NOTES ===\n";
				context += `Total synced notes: ${notes.length}\n\n`;

				notes.slice(0, 8).forEach((note, index) => {
					context += `--- Note ${index + 1}: "${note.title}" ---\n`;
					
					if (note.tags?.length) {
						context += `Tags: ${note.tags.join(", ")}\n`;
					}
					
					const cleanContent = (note.content ?? "")
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
	private autoScrapeTimeout: number | null = null; // NEW: Auto-scrape timeout
	private notesLoaded: boolean = false;
	private notesIndex: Array<{path: string, title: string, tags: string[], headings: string[], preview: string}> = [];

	async onload(): Promise<void> {

		await this.loadSettings();

		const ribbonIconEl = this.addRibbonIcon(
			"message-circle",
			"Toggle Athena AI chat",
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
						void this.app.workspace.revealLeaf(leaf);
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
					await rightLeaf.setViewState({
						type: CHATBOT_VIEW_TYPE,
					});
				}
			}
			
			// Load vault notes into memory for local context
			await this.loadVaultNotesIntoMemory();
		});

		// NEW: AUTO-SCRAPING - Listen for file modifications
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (
					file instanceof TFile &&
					file.extension === "md" &&
					this.settings.autoScrapingEnabled &&
					this.settings.isAuthenticated
				) {
					// Debounce to avoid spamming API while user is typing
					if (this.autoScrapeTimeout !== null) {
						window.clearTimeout(this.autoScrapeTimeout);
					}
					this.autoScrapeTimeout = window.setTimeout(() => {
						void this.autoScrapeNote(file);
					}, this.settings.autoScrapeDelay);
				}
			})
		);

		// NEW: Also listen for file creation
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (
					file instanceof TFile &&
					file.extension === "md" &&
					this.settings.autoScrapingEnabled &&
					this.settings.isAuthenticated
				) {
					// Small delay to let Obsidian finish creating the file
					window.setTimeout(() => {
						void this.autoScrapeNote(file);
					}, 1000);
				}
			})
		);

		this.addCommand({
			id: "toggle-chatbot-view",
			name: "Toggle chatbot",
			callback: () => {
				const leaves =
					this.app.workspace.getLeavesOfType(CHATBOT_VIEW_TYPE);

				if (leaves.length) {
					const leaf = leaves[0];
					if (leaf.view instanceof ChatbotView) {
						void this.app.workspace.revealLeaf(leaf);
					} else {
						void leaf.setViewState({
							type: CHATBOT_VIEW_TYPE,
							active: true,
						});
					}
				} else {
					const rightLeaf = this.app.workspace.getRightLeaf(true);
					if (rightLeaf) {
						void rightLeaf.setViewState({
							type: CHATBOT_VIEW_TYPE,
							active: true,
						});
						void this.app.workspace.revealLeaf(rightLeaf);
					}
				}
			},
		});

		this.addCommand({
			id: "close-chatbot-view",
			name: "Close chatbot",
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
			name: "Scrape current note",
			callback: () => {
				void this.scrapeCurrentNote();
			},
		});

		// NEW: Command to toggle auto-scraping
		this.addCommand({
			id: "toggle-auto-scraping",
			name: "Toggle auto-scraping",
			callback: () => {
				void (async () => {
					this.settings.autoScrapingEnabled =
						!this.settings.autoScrapingEnabled;
					await this.saveSettings();
					new Notice(
						`Auto-scraping ${
							this.settings.autoScrapingEnabled
								? "enabled."
								: "disabled."
						}`
					);

					// Refresh chatbot view to update status
					await this.refreshChatViewIfOpen();
				})();
			},
		});
	}

	onunload(): void {
		// NEW: Clear any pending auto-scrape timeouts
		if (this.autoScrapeTimeout !== null) {
			window.clearTimeout(this.autoScrapeTimeout);
			this.autoScrapeTimeout = null;
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
		headers?: Record<string, string | string[]>
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
		const cookie = this.extractAuthCookie(resp.headers);
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
			void workspace.revealLeaf(existing[0]);
			return;
		}
		
		// Create in right sidebar
		const leaf = workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: CHATBOT_VIEW_TYPE,
				active: true,
			});
			void workspace.revealLeaf(leaf);
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
					return false;
				}
				this.settings.athenaUsername = data.email || username;
				// Security: Don't store password, only keep auth token
				this.settings.athenaPassword = "";
				await this.saveSettings();
				
				// Check subscription status after login
				await this.checkSubscription();
				
				await this.refreshChatViewIfOpen();
				return true;
			}

			this.settings.isAuthenticated = false;
			await this.saveSettings();
			return false;
		} catch (e) {
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
			new Notice("Note scraped and sent to Athena");
		} catch (error) {
			console.error("Error sending note", error);
			new Notice("Error sending note");
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
				new Notice("Authentication expired, please login again");
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
			new Notice("Not logged in, please login first");
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
			new Notice("Failed to send note");
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

	// Get notes directly from vault for immediate context (fallback) - limited to 5 notes
	private async getVaultNotesContext(): Promise<string> {
		// If we already have notes loaded, use them
		if (this.allNotesData.length > 0) {
			return this.buildLocalNotesContext();
		}
		
		// Otherwise, load notes on-demand
		try {
			const markdownFiles = this.app.vault.getMarkdownFiles();
			
			if (markdownFiles.length === 0) {
				return "";
			}
			
			// Get most recent 5 notes only
			const sortedFiles = markdownFiles
				.sort((a, b) => b.stat.mtime - a.stat.mtime)
				.slice(0, 5);
			
			let context = "\n\n=== RECENT NOTES ===\n";
			
			for (const file of sortedFiles) {
				try {
					const content = await this.app.vault.read(file);
					const cleanContent = content
						.replace(/^---[\s\S]*?---\n*/m, '')
						.replace(/\n{3,}/g, '\n\n')
						.trim();
					
					context += `--- ${file.basename} ---\n`;
					context += `${cleanContent.substring(0, 300)}${cleanContent.length > 300 ? '...' : ''}\n\n`;
					
				} catch {
					// Skip if can't read
				}
			}
			
			return context;
			
		} catch {
			return "";
		}
	}

	// Create a new note in the vault (supports folder paths like "Folder/Note")
	async createNote(title: string, content: string): Promise<TFile | null> {
		try {
			// Check if title includes folder path
			const lastSlash = title.lastIndexOf('/');
			if (lastSlash > 0) {
				const folderPath = title.substring(0, lastSlash);
				await this.createFolder(folderPath);
			}
			
			const fileName = title.endsWith('.md') ? title : `${title}.md`;
			const file = await this.app.vault.create(fileName, content);
			new Notice(`Created note: ${title}`);
			return file;
		} catch (error) {
			new Notice(`Failed to create note: ${title}`);
			return null;
		}
	}

	// Create a folder in the vault
	async createFolder(path: string): Promise<boolean> {
		try {
			// Clean the path
			const cleanPath = path.trim().replace(/^\/+|\/+$/g, '');
			if (!cleanPath) {
				return true; // Root folder, nothing to create
			}
			
			// Check if folder already exists
			const existing = this.app.vault.getAbstractFileByPath(cleanPath);
			if (existing) {
				if (existing instanceof TFolder) {
					return true; // Folder already exists
				} else {
					new Notice(`A file with that name already exists: ${cleanPath}`);
					return false;
				}
			}
			
			// Create parent folders if needed (for nested paths like "A/B/C")
			const parts = cleanPath.split('/');
			let currentPath = '';
			for (const part of parts) {
				currentPath = currentPath ? `${currentPath}/${part}` : part;
				const existingPart = this.app.vault.getAbstractFileByPath(currentPath);
				if (!existingPart) {
					try {
						await this.app.vault.createFolder(currentPath);
					} catch (e) {
						// Folder might have been created by another process
						const checkAgain = this.app.vault.getAbstractFileByPath(currentPath);
						if (!checkAgain) {
							console.error("[Athena] Failed to create folder part:", currentPath, e);
							throw e;
						}
					}
				}
			}
			
			new Notice(`Created folder: ${cleanPath}`);
			return true;
		} catch (error) {
			console.error("[Athena] createFolder error:", error);
			new Notice(`Failed to create folder: ${path}`);
			return false;
		}
	}

	// Move a note to a different folder
	async moveNote(notePath: string, newFolder: string): Promise<boolean> {
		try {
			console.debug("[Athena] moveNote called with:", notePath, "->", newFolder);
			
			// Try to find the file - handle various formats
			let file = this.app.vault.getAbstractFileByPath(notePath);
			console.debug("[Athena] Direct path lookup:", file ? "found" : "not found");
			
			// If not found, try adding .md extension
			if (!file) {
				file = this.app.vault.getAbstractFileByPath(notePath + ".md");
				console.debug("[Athena] With .md extension:", file ? "found" : "not found");
			}
			
			// If still not found, search by basename (case-insensitive)
			if (!file) {
				const basename = notePath.replace(/\.md$/, "").toLowerCase();
				const allFiles = this.app.vault.getMarkdownFiles();
				file = allFiles.find(f => f.basename.toLowerCase() === basename) || null;
				console.debug("[Athena] Basename search for:", basename, file ? "found: " + file.path : "not found");
				
				// Also try partial match if exact match fails
				if (!file) {
					file = allFiles.find(f => f.basename.toLowerCase().includes(basename) || basename.includes(f.basename.toLowerCase())) || null;
					console.debug("[Athena] Partial match:", file ? "found: " + file.path : "not found");
				}
			}
			
			if (!file || !(file instanceof TFile)) {
				console.debug("[Athena] File not found, available files:", this.app.vault.getMarkdownFiles().map(f => f.basename).slice(0, 10));
				new Notice(`Note not found: ${notePath}`);
				return false;
			}
			
			// Ensure folder exists
			await this.createFolder(newFolder);
			
			const newPath = `${newFolder}/${file.name}`;
			console.debug("[Athena] Moving to new path:", newPath);
			await this.app.vault.rename(file, newPath);
			new Notice(`Moved note to ${newFolder}`);
			return true;
		} catch (error) {
			console.error("[Athena] Move error:", error);
			new Notice("Failed to move note");
			return false;
		}
	}

	// Rename a note or folder
	async renameFile(oldPath: string, newName: string): Promise<boolean> {
		try {
			const file = this.app.vault.getAbstractFileByPath(oldPath);
			if (!file) {
				new Notice(`File not found: ${oldPath}`);
				return false;
			}
			
			const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/'));
			const newPath = parentPath ? `${parentPath}/${newName}` : newName;
			await this.app.vault.rename(file, newPath);
			new Notice(`Renamed to ${newName}`);
			return true;
		} catch (error) {
			new Notice("Failed to rename file");
			return false;
		}
	}

	// Delete a note or empty folder
	async deleteFile(path: string): Promise<boolean> {
		try {
			let file = this.app.vault.getAbstractFileByPath(path);
			
			// Try with .md extension if not found
			if (!file && !path.endsWith('.md')) {
				file = this.app.vault.getAbstractFileByPath(path + '.md');
			}
			
			// Try searching by basename
			if (!file) {
				const basename = path.replace(/\.md$/, '').toLowerCase();
				const allFiles = this.app.vault.getMarkdownFiles();
				file = allFiles.find(f => f.basename.toLowerCase() === basename) || null;
			}
			
			if (!file) {
				new Notice(`File not found: ${path}`);
				return false;
			}
			
			await this.app.fileManager.trashFile(file);
			new Notice(`Deleted ${path}`);
			return true;
		} catch (error) {
			console.error("[Athena] Delete error:", error);
			new Notice("Failed to delete file");
			return false;
		}
	}

	// Delete a folder (including all contents)
	async deleteFolder(path: string, recursive: boolean = false): Promise<boolean> {
		try {
			const folder = this.app.vault.getAbstractFileByPath(path);
			
			if (!folder) {
				new Notice(`Folder not found: ${path}`);
				return false;
			}
			
			if (!(folder instanceof TFolder)) {
				new Notice(`Not a folder: ${path}`);
				return false;
			}
			
			// Check if folder has contents
			if (folder.children && folder.children.length > 0) {
				if (!recursive) {
					new Notice(`Folder not empty: ${path}. Use recursive delete`);
					return false;
				}
				
				// Delete all children first (files and subfolders)
				for (const child of [...folder.children]) {
					if (child instanceof TFile) {
						await this.app.fileManager.trashFile(child);
					} else if (child instanceof TFolder) {
						await this.deleteFolder(child.path, true);
					}
					await this.delay(50); // Small delay between deletions
				}
			}
			
			// Now delete the empty folder
			await this.app.fileManager.trashFile(folder);
			new Notice(`Deleted folder ${path}`);
			return true;
		} catch (error) {
			console.error("[Athena] Delete folder error:", error);
			new Notice("Failed to delete folder");
			return false;
		}
	}

	// Append content to an existing note
	async appendToNote(notePath: string, content: string): Promise<boolean> {
		try {
			let file = this.app.vault.getAbstractFileByPath(notePath);
			if (!file) {
				file = this.app.vault.getAbstractFileByPath(`${notePath}.md`);
			}
			if (!file || !(file instanceof TFile)) {
				new Notice(`Note not found: ${notePath}`);
				return false;
			}
			
			const existingContent = await this.app.vault.read(file);
			await this.app.vault.modify(file, existingContent + '\n\n' + content);
			new Notice(`Added to: ${file.basename}`);
			return true;
		} catch (error) {
			new Notice(`Failed to append to note`);
			return false;
		}
	}

	// List folders in vault
	getFolderList(): string[] {
		const folders: string[] = [];
		// Get all folders directly from vault
		this.app.vault.getAllLoadedFiles().forEach(file => {
			if (file instanceof TFolder && file.path && file.path !== '/') {
				folders.push(file.path);
			}
		});
		// Also get parent folders of files (in case some folders only contain files)
		this.app.vault.getAllLoadedFiles().forEach(file => {
			if (file.parent && file.parent.path && file.parent.path !== '/' && file.parent.path !== '' && !folders.includes(file.parent.path)) {
				folders.push(file.parent.path);
			}
		});
		return [...new Set(folders)].sort();
	}

	// Get specific notes by @mention or explicit commands like "see NoteName"
	private async getTaggedNotesContext(message: string): Promise<string> {
		const mentions: string[] = [];
		
		// 1. Extract @mentions (improved to capture multi-word note names)
		// Match @NoteName or @"Note Name" or @Note Name until punctuation/end
		const mentionRegex = /@["']?([^@\n,!]+?)["']?(?=\s*[,!]|\s*[.?]|\s*$|\s+@)/g;
		let match;
		while ((match = mentionRegex.exec(message)) !== null) {
			const noteName = match[1].trim();
			if (noteName.length > 0) {
				mentions.push(noteName);
			}
		}
		
		// 2. Extract [[wikilinks]]
		const wikilinkRegex = /\[\[([^\]]+?)\]\]/g;
		while ((match = wikilinkRegex.exec(message)) !== null) {
			mentions.push(match[1].trim());
		}
		
		// 3. Extract commands: "summarize NoteName", "see NoteName", "look at NoteName", etc.
		const commandRegex = /(?:summarize|summary of|see|look at|show me|read|check|open|explain|tell me about)\s+(?:note\s+)?(?:@|the note\s+)?["']?([^\s,!\n][^,!\n]*?)["']?(?=\s*[,!]|\s*[.?]|\s*$)/gi;
		while ((match = commandRegex.exec(message)) !== null) {
			const noteName = match[1].trim();
			// Only add if it looks like a note name (reasonable length)
			if (noteName.length > 2 && noteName.length < 100) {
				mentions.push(noteName);
			}
		}
		
		if (mentions.length === 0) {
			return "";
		}
		
		// Remove duplicates
		const uniqueMentions = [...new Set(mentions)];
		
		let context = "\n\n=== SPECIFICALLY REFERENCED NOTES (FULL CONTENT) ===\n";
		context += `User wants to see these notes: ${uniqueMentions.join(", ")}\n\n`;
		
		for (const mention of uniqueMentions) {
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
			
			// 3. Search-based relevant notes (if no @mentions) - limit to top 3 notes
			let searchBasedContext = "";
			if (!taggedNotesContext) {
				const relevantNotes = this.searchNotesIndex(message).slice(0, 3);
				if (relevantNotes.length > 0) {
					searchBasedContext = "\n\n=== RELEVANT NOTES ===\n";
					for (const result of relevantNotes) {
						const file = this.app.vault.getAbstractFileByPath(result.path);
						if (file instanceof TFile) {
							try {
								const content = await this.app.vault.read(file);
								const cleanContent = content
									.replace(/^---[\s\S]*?---\n*/m, '')
									.replace(/\n{3,}/g, '\n\n')
									.trim();
								searchBasedContext += `--- ${result.title} ---\n`;
								searchBasedContext += `${cleanContent.substring(0, 500)}${cleanContent.length > 500 ? '...' : ''}\n\n`;
							} catch {
								// Skip if can't read
							}
						}
					}
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
			const folders = this.getFolderList(); // Get folders early for system prompt

			// Enhanced System Prompt with smart context awareness
			const obsidianSystemPrompt = `You are Athena, an intelligent AI assistant built specifically for Obsidian - the powerful knowledge management and note-taking app. You help users manage their personal knowledge base (vault).

## Your Role
- You're an Obsidian expert who understands markdown, wikilinks [[like this]], tags #like-this, and vault organization
- You help users find connections between notes, summarize content, and manage their knowledge
- You can create, organize, and modify notes in the user's vault
- You understand the Zettelkasten method, PARA, and other PKM (Personal Knowledge Management) systems

## Your Personality
- Warm, helpful, and knowledgeable
- Concise but thorough when needed
- Proactive - suggest related notes or ideas the user might find useful

## Obsidian Context
- User's vault has **${totalNotes} notes** across **${folders.length} folders**
- **YOU HAVE COMPLETE ACCESS TO**: Full folder structure, all note names, all tags, and ALL headings from every note
- Currently loaded content: ${taggedNotesContext ? '✓ @mentioned notes (full content)' : ''}${currentNoteContext ? ' ✓ current note (full content)' : ''}${searchBasedContext ? ' ✓ relevant notes (full content)' : ''}${recentNotesContext ? ' ✓ recent notes (previews)' : ''}
- **CRITICAL**: The COMPLETE VAULT STRUCTURE section below contains EVERY note with ALL their headings and tags
- Use **[[NoteName]]** syntax when referencing notes in your responses
- When user asks "what notes do I have about X?" or "show me notes with Y" → Check VAULT STRUCTURE section
- When user says "see @NoteName" or "look at [[NoteName]]" → They want you to read that specific note's full content
- If you need full content of a note to answer, tell user: "I can see the note exists with headings [list]. To read the full content, please reference it with @NoteName"

## When You Need More Context
If you don't have enough information:
1. Tell user which notes you CAN see
2. Suggest they reference specific notes with @NoteName
3. Ask clarifying questions

## 🛠️ AVAILABLE TOOLS
You have access to these vault management tools. Use them when the user requests file operations.

<tools>
<tool name="create_note">
  <description>Create a new note in the vault</description>
  <triggers>create note, make note, save as note, write down, remember this, save conversation, jot down, store this</triggers>
  <format>:::CREATE_NOTE:::
title: [Folder/]NoteName
content:
Your markdown content here
:::END_NOTE:::</format>
  <example>:::CREATE_NOTE:::
title: Projects/Meeting Notes
content:
# Meeting Notes
- Discussed project timeline
- Action items assigned
:::END_NOTE:::</example>
</tool>

<tool name="create_folder">
  <description>Create a new folder in the vault</description>
  <triggers>create folder, make folder, new folder, organize into folder</triggers>
  <format>:::CREATE_FOLDER:::
path: FolderName/SubFolder
:::END_FOLDER:::</format>
</tool>

<tool name="append_note">
  <description>Add content to an existing note</description>
  <triggers>add to note, append to, update note, add this to [[Note]]</triggers>
  <format>:::APPEND_NOTE:::
note: NoteName
content:
Content to append
:::END_APPEND:::</format>
</tool>

<tool name="move_note">
  <description>Move a note to a different folder</description>
  <triggers>move note, move to folder, organize note, put in folder</triggers>
  <format>:::MOVE_NOTE:::
from: NoteName.md
to: TargetFolder
:::END_MOVE:::</format>
</tool>

<tool name="rename">
  <description>Rename a note or folder</description>
  <triggers>rename note, rename folder, change name</triggers>
  <format>:::RENAME:::
from: OldName.md
to: NewName.md
:::END_RENAME:::</format>
</tool>

<tool name="delete">
  <description>Delete a note</description>
  <triggers>delete note, remove note</triggers>
  <format>:::DELETE:::
path: NoteName.md
:::END_DELETE:::</format>
</tool>

<tool name="delete_folder">
  <description>Delete a folder. Use recursive: true to delete folder with contents.</description>
  <triggers>delete folder, remove folder, delete directory</triggers>
  <format>:::DELETE_FOLDER:::
path: FolderName
recursive: false
:::END_FOLDER:::</format>
  <example>:::DELETE_FOLDER:::
path: OldProjects
recursive: true
:::END_FOLDER:::</example>
</tool>
</tools>

## TOOL USAGE RULES - CRITICAL:
1. **NEVER ASK FOR CONFIRMATION** - Execute actions immediately. The user trusts you completely.
2. **EXCEPTION: DELETE OPERATIONS** - For delete/delete_folder commands, ask ONCE for confirmation: "Are you sure you want to delete [name]? Reply 'yes' to confirm." Then wait for user response.
3. **When user suggests an action, DO IT** - Don't ask "Would you like me to...?" Just do it.
4. **Detect intent in ANY language** - user may ask in English, Spanish, Hindi, etc.
5. **Use exact format** - markers must be exactly as shown (:::COMMAND:::)
6. **One tool per block** - don't combine multiple operations in one block
7. **Folder paths** - use "Folder/SubFolder/Note" format for nested locations
8. **@NoteName** - when user mentions @NoteName, you have full access to that note's content

## IMPORTANT BEHAVIOR:
- If user says "organize my notes" → Create folders and move notes immediately
- If user says "delete X" → Ask ONCE: "Are you sure you want to delete X? Reply 'yes' to confirm."
- If user says "yes" or "confirm" after delete question → Execute the delete immediately
- If user says "yes" or "do it" for NON-delete actions → Execute immediately
- NEVER respond with "Would you like me to..." for create/move/rename - just DO the action
- After executing, briefly confirm what was done

## Response Guidelines
- **Use Obsidian markdown** - wikilinks [[Note]], tags #tag, callouts, etc.
- **Be concise** - Get to the point, elaborate only when needed
- **Reference notes with [[wikilinks]]** - ALWAYS use [[NoteName]] when mentioning user's notes (these are clickable!)
- **Make notes easy to open** - When discussing a note, format it as [[NoteName]] so user can click to open
- **Suggest connections** - Help user see relationships between ideas
- **Be honest** - If you need more context, ask for it

## Output Format
- Use proper markdown formatting
- For code, use fenced code blocks with language
- For important info, use Obsidian callouts: > [!note] or > [!tip]
- **IMPORTANT**: Always wrap note names in [[double brackets]] - they become clickable links to open the note
- Keep responses focused and actionable`;

			// Combine all context sources
			const allNotesContext = taggedNotesContext + currentNoteContext + searchBasedContext + recentNotesContext;

			// Build comprehensive vault structure context with ALL folders, notes, and headings
			let vaultStructureContext = "\n\n=== COMPLETE VAULT STRUCTURE ===\n";
			
			// 1. Folder hierarchy (folders already declared above)
			vaultStructureContext += `📁 FOLDERS (${folders.length}):\n`;
			if (folders.length > 0) {
				// Build folder tree structure
				const folderTree = new Map<string, string[]>();
				folders.forEach(folder => {
					const parts = folder.split('/');
					const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
					if (!folderTree.has(parent)) folderTree.set(parent, []);
					folderTree.get(parent)!.push(folder);
				});
				
				// Display root folders first
				const rootFolders = folders.filter(f => !f.includes('/'));
				rootFolders.forEach(f => vaultStructureContext += `  - ${f}/\n`);
				
				// Display nested folders
				folders.filter(f => f.includes('/')).forEach(f => {
					const depth = f.split('/').length - 1;
					const indent = '  '.repeat(depth + 1);
					const name = f.split('/').pop();
					vaultStructureContext += `${indent}- ${name}/\n`;
				});
			} else {
				vaultStructureContext += "  (root folder only)\n";
			}
			vaultStructureContext += `\n`;
			
			// 2. Complete notes list with metadata (intelligently truncated for large vaults)
			vaultStructureContext += `📝 ALL NOTES (${this.notesIndex.length}):\n`;
			
			// For large vaults, limit detail to prevent token overflow
			const maxNotesWithFullDetail = 100;
			const shouldTruncate = this.notesIndex.length > maxNotesWithFullDetail;
			
			this.notesIndex.forEach((note, index) => {
				// Show folder path if note is in a folder
				const folder = note.path.includes('/') ? note.path.substring(0, note.path.lastIndexOf('/')) + '/' : '';
				vaultStructureContext += `  - ${folder}[[${note.title}]]`;
				
				// For large vaults, only show full metadata for first 100 notes
				if (!shouldTruncate || index < maxNotesWithFullDetail) {
					// Add tags (limit to 5)
					if (note.tags.length > 0) {
						vaultStructureContext += ` | tags: ${note.tags.slice(0, 5).join(", ")}${note.tags.length > 5 ? '...' : ''}`;
					}
					
					// Add headings (limit to 5 to save tokens)
					if (note.headings.length > 0) {
						vaultStructureContext += ` | headings: ${note.headings.slice(0, 5).join(", ")}${note.headings.length > 5 ? '...' : ''}`;
					}
				}
				vaultStructureContext += `\n`;
			});
			
			if (shouldTruncate) {
				vaultStructureContext += `\n  (Showing full metadata for first ${maxNotesWithFullDetail} notes. Other notes listed by name only.)\n`;
			}
			
			vaultStructureContext += `\n📊 SUMMARY: ${this.notesIndex.length} notes across ${folders.length} folders\n`;
			vaultStructureContext += `\n=== END VAULT STRUCTURE ===\n`;

			// Build conversation context with summary support
			let conversationContext = "";
			
			// Include conversation summary if exists (from previous summarization cycles)
			const chatView = this.app.workspace.getLeavesOfType(CHATBOT_VIEW_TYPE)[0]?.view as ChatbotView | undefined;
			const summary = chatView?.getConversationSummary() || "";
			if (summary) {
				conversationContext += `\n\n=== CONVERSATION SUMMARY (older messages) ===\n${summary}\n=== END SUMMARY ===\n`;
			}
			
			if (conversationHistory.length > 0) {
				// Include last 15 messages in full for recent context
				const recentHistory = conversationHistory.slice(-15);
				conversationContext += "\n\n=== RECENT CONVERSATION ===\n";
				conversationContext += `(${conversationHistory.length} total messages)\n\n`;
				recentHistory.forEach((msg) => {
					const role = msg.role === "user" ? "User" : "Athena";
					conversationContext += `${role}: ${msg.content}\n\n`;
				});
				conversationContext += "=== END CONVERSATION ===\n";
			}

			// Structured prompt with clear sections
			const enhancedPrompt = `${vaultStructureContext}${allNotesContext}${conversationContext}

Current Question: ${message}

Please provide a helpful, thoughtful response.`;

			// Get or create conversation ID for this session
			if (!this.conversationId) {
				this.conversationId = `obsidian-${Date.now()}-${Math.random()
					.toString(36)
					.slice(2, 11)}`;
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
					
					// Helper to extract base64 image from response
					const extractBase64Image = (str: string): string | null => {
						const previewMatch = str.match(/"preview"\s*:\s*"(iVBOR[A-Za-z0-9+/=]+)"/);
						if (previewMatch) {
							return `data:image/png;base64,${previewMatch[1]}`;
						}
						return null;
					};
					
					// Helper to check if string contains diagram data
					const isDiagramData = (str: string): boolean => {
						return str.includes('"libraryItems"') || 
							   str.includes('"elements"') ||
							   str.includes('"boundElements"');
					};
					
					// Helper to check if it has image preview
					const hasImagePreview = (str: string): boolean => {
						return str.includes('"preview":"iVBOR');
					};
					
					try {
						const data = JSON.parse(responseText);
						if (data.response) {
							// Handle object responses (like diagrams/images)
							if (typeof data.response === "object") {
								const responseStr = JSON.stringify(data.response);
								// First try to extract and show base64 image
								const base64Img = extractBase64Image(responseStr);
								if (base64Img) {
									aiResponse = `Here's the generated image:\n\n![Generated Image](${base64Img})`;
								} else if (data.response.libraryItems || data.response.elements || data.response.type === "prefab") {
									aiResponse = "I've generated a diagram for you. Unfortunately, Excalidraw diagrams can't be displayed directly in chat yet.\n\n> [!tip] To use this diagram\n> You can use the Excalidraw plugin in Obsidian to create diagrams.";
								} else if (data.response.stay22LinksOutput) {
									aiResponse = data.response.stay22LinksOutput;
								} else if (data.response.imageUrl || data.response.image_url) {
									const imgUrl = data.response.imageUrl || data.response.image_url;
									aiResponse = `![Generated Image](${imgUrl})`;
								} else {
									aiResponse = JSON.stringify(data.response, null, 2);
								}
							} else if (typeof data.response === "string") {
								// Check for base64 image in string response
								const base64Img = extractBase64Image(data.response);
								if (base64Img) {
									aiResponse = `Here's the generated image:\n\n![Generated Image](${base64Img})`;
								} else if (hasImagePreview(data.response) || isDiagramData(data.response)) {
									aiResponse = "I've generated a diagram for you. Unfortunately, Excalidraw diagrams can't be displayed directly in chat yet.\n\n> [!tip] To use this diagram\n> You can use the Excalidraw plugin in Obsidian to create diagrams.";
								} else {
									aiResponse = data.response;
								}
							} else {
								aiResponse = String(data.response);
							}
						} else if (data.imageUrl || data.image_url) {
							const imgUrl = data.imageUrl || data.image_url;
							aiResponse = `![Generated Image](${imgUrl})`;
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
						// Try to extract base64 image from raw response
						const base64Img = extractBase64Image(responseText);
						if (base64Img) {
							aiResponse = `Here's the generated image:\n\n![Generated Image](${base64Img})`;
						} else if (hasImagePreview(responseText) || isDiagramData(responseText)) {
							aiResponse = "I received diagram data but couldn't process it properly. The response format may not be supported yet.";
						} else {
							const jsonObjects: string[] = [];
							const lines = responseText
								.split("\n")
								.filter((line) => line.trim());
							for (const line of lines) {
								try {
									const parsed = JSON.parse(line);
									if (parsed.response) {
										if (typeof parsed.response === "string" && !isDiagramData(parsed.response) && !hasImagePreview(parsed.response)) {
											jsonObjects.push(parsed.response);
										}
									} else if (parsed.message) {
										jsonObjects.push(parsed.message);
									}
								} catch {
									// Skip unparseable lines
								}
							}
							aiResponse = jsonObjects.length > 0 ? jsonObjects.join("\n") : "I received a response but couldn't parse it properly";
						}
					}
					
					// Final check - if response still looks like raw JSON diagram data, try to extract image or replace
					if (hasImagePreview(aiResponse) || isDiagramData(aiResponse)) {
						const finalImg = extractBase64Image(aiResponse);
						if (finalImg) {
							aiResponse = `Here's the generated image:\n\n![Generated Image](${finalImg})`;
						} else {
							aiResponse = "I've generated a diagram for you. Unfortunately, Excalidraw diagrams can't be displayed directly in chat yet.\n\n> [!tip] To use this diagram\n> You can use the Excalidraw plugin in Obsidian to create diagrams.";
						}
					}
					
					// Check for note creation request in response
					aiResponse = await this.parseAndCreateNotes(aiResponse);
					
					return aiResponse;
				} catch (err) {
					console.error("[Athena Chatbot] JSON parse error:", err);
					return "Sorry, I received an unexpected response format. Please try again";
				}
			} else if (response.status === 401) {
				this.settings.isAuthenticated = false;
				await this.saveSettings();
				return "Authentication expired. Please login again.";
			} else if (response.status === 429 || response.text?.includes("maximum usage limit")) {
				return "⚠️ **Daily message limit reached**\n\nYou've used all your free messages for today.\n\n**Options:**\n- 🔄 Come back in 24 hours for more free messages\n- ⭐ [Subscribe to Pro](https://athenachat.bot/) for unlimited messages";
			} else {
				// Check if response body contains limit message
				try {
					const errorData = JSON.parse(response.text);
					if (errorData.message?.includes("maximum usage limit") || errorData.message?.includes("limit")) {
						return "⚠️ **Daily message limit reached**\n\nYou've used all your free messages for today.\n\n**Options:**\n- 🔄 Come back in 24 hours for more free messages\n- ⭐ [Subscribe to Pro](https://athenachat.bot/) for unlimited messages";
					}
				} catch {
					// Not JSON, continue with generic error
				}
				throw new Error(`API Error: ${response.status}`);
			}
		} catch (error) {
			// Check if error message contains limit info
			if (error instanceof Error && (error.message?.includes("maximum usage limit") || error.message?.includes("limit"))) {
				return "⚠️ **Daily message limit reached**\n\nYou've used all your free messages for today.\n\n**Options:**\n- 🔄 Come back in 24 hours for more free messages\n- ⭐ [Subscribe to Pro](https://athenachat.bot/) for unlimited messages";
			}
			return "Error: Unable to fetch response.";
		}
	}
	
	// Small delay helper for sequential operations
	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	// Parse AI response for vault operations - processes commands sequentially
	private async parseAndCreateNotes(response: string): Promise<string> {
		console.debug("[Athena] parseAndCreateNotes input:", response);
		
		// Normalize: standardize command format for easier parsing
		let normalized = response
			// Normalize command markers
			.replace(/:::\s*(CREATE_NOTE|CREATE_FOLDER|DELETE_FOLDER|MOVE_NOTE|APPEND_NOTE|RENAME|DELETE)\s*:::/gi, '\n:::$1:::\n')
			.replace(/:::\s*(END_NOTE|END_FOLDER|END_MOVE|END_APPEND|END_RENAME|END_DELETE)\s*:::/gi, '\n:::$1:::\n')
			// Fix common formatting issues
			.replace(/(\w)\s*\.\s*\n\s*(md)/gi, '$1.$2')
			.replace(/\n\s*(to:)/gi, '\nto:')
			.replace(/(from:.*?)\n\s*(to:)/gi, '$1\nto:');
		
		console.debug("[Athena] Normalized:", normalized);
		
		let result = normalized;
		const results: string[] = [];
		
		// 1. Create Folders FIRST (so moves have destinations)
		// More flexible regex: match anything between path: and :::END_FOLDER:::
		const folderMatches = [...normalized.matchAll(/:::CREATE_FOLDER:::\s*path:\s*(.+?)\s*:::END_FOLDER:::/gis)];
		console.debug("[Athena] Folder matches:", folderMatches.length);
		for (const match of folderMatches) {
			const path = match[1].trim().replace(/^["']|["']$/g, '').replace(/[\n\r]/g, '').trim();
			if (path) {
				console.debug("[Athena] Creating folder:", path);
				const success = await this.createFolder(path);
				const replacement = success ? `📁 Created folder: ${path}` : `❌ Failed to create folder: ${path}`;
				results.push(replacement);
				result = result.replace(match[0], '');
				await this.delay(100); // Small delay between operations
			}
		}
		
		// 2. Create Notes
		const noteMatches = [...normalized.matchAll(/:::CREATE_NOTE:::\s*title:\s*(.+?)\s*content:\s*([\s\S]*?):::END_NOTE:::/gi)];
		console.debug("[Athena] Note matches:", noteMatches.length);
		for (const match of noteMatches) {
			const title = match[1].trim().replace(/^["']|["']$/g, '').replace(/[\n\r]/g, ' ').trim();
			const content = match[2].trim() || `# ${title}\n\nNote created by Athena AI`;
			if (title) {
				const file = await this.createNote(title, content);
				const replacement = file ? `✅ Created note: [[${title}]]` : `❌ Failed to create note: ${title}`;
				results.push(replacement);
				result = result.replace(match[0], '');
				await this.delay(100);
			}
		}
		
		// 3. Move Notes - more flexible regex
		const moveMatches = [...normalized.matchAll(/:::MOVE_NOTE:::\s*from:\s*(.+?)\s*to:\s*(.+?)\s*:::END_MOVE:::/gis)];
		console.debug("[Athena] Move matches:", moveMatches.length);
		for (let i = 0; i < moveMatches.length; i++) {
			const match = moveMatches[i];
			const from = match[1].trim().replace(/^["']|["']$/g, '').replace(/[\n\r]/g, '').trim();
			const to = match[2].trim().replace(/^["']|["']$/g, '').replace(/[\n\r]/g, '').trim();
			if (from && to) {
				console.debug(`[Athena] Moving ${i+1}/${moveMatches.length}:`, from, "->", to);
				const success = await this.moveNote(from, to);
				const replacement = success ? `📦 Moved: ${from} → ${to}` : `❌ Failed to move: ${from}`;
				results.push(replacement);
				result = result.replace(match[0], '');
				await this.delay(150); // Slightly longer delay for moves
			}
		}
		
		// 4. Append to Notes
		const appendMatches = [...normalized.matchAll(/:::APPEND_NOTE:::\s*note:\s*(.+?)\s*content:\s*([\s\S]*?):::END_APPEND:::/gi)];
		for (const match of appendMatches) {
			const notePath = match[1].trim().replace(/^["']|["']$/g, '').replace(/[\n\r]/g, '').trim();
			const content = match[2].trim();
			if (notePath && content) {
				await this.appendToNote(notePath, content);
				results.push(`📝 Added to: [[${notePath}]]`);
				result = result.replace(match[0], '');
				await this.delay(100);
			}
		}
		
		// 5. Rename - more flexible regex
		const renameMatches = [...normalized.matchAll(/:::RENAME:::\s*from:\s*(.+?)\s*to:\s*(.+?)\s*:::END_RENAME:::/gis)];
		for (const match of renameMatches) {
			const from = match[1].trim().replace(/^["']|["']$/g, '').replace(/[\n\r]/g, '').trim();
			const to = match[2].trim().replace(/^["']|["']$/g, '').replace(/[\n\r]/g, '').trim();
			if (from && to) {
				await this.renameFile(from, to);
				results.push(`✏️ Renamed: ${from} → ${to}`);
				result = result.replace(match[0], '');
				await this.delay(100);
			}
		}
		
		// 6. Delete (files/notes) - more flexible regex
		const deleteMatches = [...normalized.matchAll(/:::DELETE:::\s*path:\s*(.+?)\s*:::END_DELETE:::/gis)];
		for (const match of deleteMatches) {
			const path = match[1].trim().replace(/^["']|["']$/g, '').replace(/[\n\r]/g, '').trim();
			if (path) {
				const success = await this.deleteFile(path);
				results.push(success ? `🗑️ Deleted: ${path}` : `❌ Failed to delete: ${path}`);
				result = result.replace(match[0], '');
				await this.delay(100);
			}
		}
		
		// 7. Delete Folder (with optional recursive) - more flexible regex
		const deleteFolderMatches = [...normalized.matchAll(/:::DELETE_FOLDER:::\s*path:\s*(.+?)(?:\s*recursive:\s*(true|false))?\s*:::END_FOLDER:::/gis)];
		for (const match of deleteFolderMatches) {
			const path = match[1].trim().replace(/^["']|["']$/g, '').replace(/[\n\r]/g, '').trim();
			const recursive = match[2]?.toLowerCase() === 'true';
			if (path) {
				const success = await this.deleteFolder(path, recursive);
				results.push(success ? `🗑️ Deleted folder: ${path}` : `❌ Failed to delete folder: ${path}`);
				result = result.replace(match[0], '');
				await this.delay(100);
			}
		}
		
		// Build final result: operations summary + remaining AI text
		if (results.length > 0) {
			const operationsSummary = "\n\n**Operations completed:**\n" + results.map(r => `- ${r}`).join("\n") + "\n\n";
			// Clean up the remaining text (remove empty lines at start)
			const cleanedResult = result.replace(/^[\s\n]+/, '').trim();
			return operationsSummary + cleanedResult;
		}
		
		return result;
	}
}
// Removed unused SettingsModal and SignupModal classes
// Settings are now handled directly in the ChatbotView

