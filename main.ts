import { Plugin, Notice, TFile, CachedMetadata } from 'obsidian';


// Changed with code that scrapes obsidian and sends the data to Athena AI


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
    frontmatter?: Record<string, any>;
    // wordCount: number;
    // size: number;
}


export default class NoteScraperPlugin extends Plugin {
    // Store all scraped data here
    private allNotesData: NoteData[] = [];
   
    onload(): void {
        console.log("NoteScraperPlugin loaded");


        // Add this command to the command palette
        this.addCommand({
            id: 'scrape-current-note',
            name: 'Scrape',
            callback: async () => { // callback function is used because scraping a file takes time. We pause operations via the async keyword and call back the results of the scrape method once it is done scraping.
                await this.scrapeCurrentNote();
                new Notice("Test Note scraped successfully!");
            }
        });
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


        } catch (error) {
            console.error('Error scraping note', error);
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
            const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags];
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
