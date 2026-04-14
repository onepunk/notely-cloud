/**
 * Export Service - Handles exporting notes with transcriptions and summaries to various formats
 */

import fs from 'fs/promises';
import path from 'path';

import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import { app, dialog } from 'electron';
import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';

import { logger } from '../../logger';
import type { INoteService } from '../../storage/interfaces/INoteService';
import type { ISummaryService } from '../../storage/interfaces/ISummaryService';
import type { ITranscriptionService } from '../../storage/interfaces/ITranscriptionService';

export type ExportFormat = 'txt' | 'md' | 'docx' | 'rtf' | 'pdf';

export interface AggregatedNoteData {
  title: string;
  content: string;
  createdAt: Date;
  transcriptions: Array<{
    id: string;
    startTime: Date;
    text: string;
    summaries: Array<{
      id: string;
      type: string;
      text: string;
    }>;
  }>;
}

export interface ExportResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

export interface ExportServiceDeps {
  noteService: INoteService;
  transcriptionService: ITranscriptionService;
  summaryService: ISummaryService;
}

export class ExportService {
  private noteService: INoteService;
  private transcriptionService: ITranscriptionService;
  private summaryService: ISummaryService;

  constructor(deps: ExportServiceDeps) {
    this.noteService = deps.noteService;
    this.transcriptionService = deps.transcriptionService;
    this.summaryService = deps.summaryService;
  }

  /**
   * Extract plain text from Lexical editor JSON
   * Recursively traverses the Lexical node tree to extract text content
   */
  private extractTextFromLexical(lexicalJson: string | null | undefined): string {
    if (!lexicalJson || lexicalJson === 'null') return '';

    try {
      const parsed = JSON.parse(lexicalJson);
      return this.extractTextFromNode(parsed.root);
    } catch {
      return '';
    }
  }

  /**
   * Recursively extract text from a Lexical node
   */
  private extractTextFromNode(node: unknown): string {
    if (!node || typeof node !== 'object') return '';

    const nodeObj = node as Record<string, unknown>;

    // If this is a text node, return its text
    if (typeof nodeObj.text === 'string') {
      return nodeObj.text;
    }

    // If this node has children, recursively extract text
    if (Array.isArray(nodeObj.children)) {
      const texts: string[] = [];
      for (const child of nodeObj.children) {
        const text = this.extractTextFromNode(child);
        if (text) texts.push(text);
      }
      // Join with newlines for block-level elements (paragraphs, headings)
      return texts.join('\n');
    }

    return '';
  }

  async exportNote(noteId: string, format: ExportFormat): Promise<ExportResult> {
    try {
      logger.info('ExportService: Starting export', { noteId, format });

      // Aggregate all data
      const data = await this.aggregateNoteData(noteId);

      // Show save dialog
      const filePath = await this.showSaveDialog(format, data.title);
      if (!filePath) {
        logger.info('ExportService: Export cancelled by user');
        return { success: false, error: 'Export cancelled' };
      }

      // Generate content based on format
      let content: Buffer | string;
      switch (format) {
        case 'txt':
          content = this.formatToTxt(data);
          break;
        case 'md':
          content = this.formatToMd(data);
          break;
        case 'docx':
          content = await this.formatToDocx(data);
          break;
        case 'rtf':
          content = this.formatToRtf(data);
          break;
        case 'pdf':
          content = await this.formatToPdf(data);
          break;
        default:
          throw new Error(`Unsupported format: ${format}`);
      }

      // Write to file
      await fs.writeFile(filePath, content);

      logger.info('ExportService: Export completed', { noteId, format, filePath });
      return { success: true, filePath };
    } catch (error) {
      logger.error('ExportService: Export failed', {
        noteId,
        format,
        error: error instanceof Error ? error.message : error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Export failed',
      };
    }
  }

  async aggregateNoteData(noteId: string): Promise<AggregatedNoteData> {
    // Get note
    const note = await this.noteService.get(noteId);

    logger.debug('ExportService: Note data retrieved', {
      noteId,
      title: note.meta.title,
      plainTextLength: note.content.plainText?.length || 0,
      lexicalJsonLength: note.content.lexicalJson?.length || 0,
    });

    // Get transcriptions for this note
    const transcriptions = await this.transcriptionService.listByNote(noteId);

    logger.debug('ExportService: Transcriptions found', {
      noteId,
      count: transcriptions.length,
      statuses: transcriptions.map((t) => t.status),
    });

    // Build aggregated data with summaries
    const transcriptionsWithSummaries = await Promise.all(
      transcriptions
        .filter((t) => t.status === 'completed') // Only completed transcriptions
        .map(async (t) => {
          const { fullText } = await this.transcriptionService.getSession(t.id);
          const summaries = await this.summaryService.getByTranscriptionId(t.id);

          return {
            id: t.id,
            startTime: t.startTime,
            text: fullText,
            summaries: summaries
              .filter((s) => s.summaryText && s.summaryText.trim()) // Skip empty summaries
              .map((s) => ({
                id: s.id,
                type: s.summaryType || 'Summary',
                text: s.summaryText || '',
              })),
          };
        })
    );

    return {
      title: note.meta.title || 'Untitled Note',
      content: this.extractTextFromLexical(note.content.lexicalJson),
      createdAt: note.meta.createdAt,
      transcriptions: transcriptionsWithSummaries.filter((t) => t.text && t.text.trim()), // Skip empty
    };
  }

  formatToTxt(data: AggregatedNoteData): string {
    const sections: string[] = [];

    // Title
    sections.push(data.title);
    sections.push('='.repeat(Math.min(data.title.length, 80)));

    // Note content (if present)
    if (data.content.trim()) {
      sections.push('');
      sections.push('NOTE CONTENT');
      sections.push('-'.repeat(12));
      sections.push(data.content);
    }

    // Transcriptions and summaries
    for (const t of data.transcriptions) {
      sections.push('');
      sections.push(`TRANSCRIPTION - ${t.startTime.toLocaleString()}`);
      sections.push('-'.repeat(40));
      sections.push(t.text);

      for (const s of t.summaries) {
        sections.push('');
        sections.push(`SUMMARY (${s.type})`);
        sections.push('-'.repeat(20));
        sections.push(s.text);
      }
    }

    return sections.join('\n');
  }

  formatToMd(data: AggregatedNoteData): string {
    const sections: string[] = [];

    // Title
    sections.push(`# ${data.title}`);

    // Note content (if present)
    if (data.content.trim()) {
      sections.push('');
      sections.push('## Note Content');
      sections.push('');
      sections.push(data.content);
    }

    // Transcriptions and summaries
    for (const t of data.transcriptions) {
      sections.push('');
      sections.push(`## Transcription - ${t.startTime.toLocaleString()}`);
      sections.push('');
      sections.push(t.text);

      for (const s of t.summaries) {
        sections.push('');
        sections.push(`### Summary (${s.type})`);
        sections.push('');
        sections.push(s.text);
      }
    }

    return sections.join('\n');
  }

  async formatToDocx(data: AggregatedNoteData): Promise<Buffer> {
    const children: Paragraph[] = [];

    // Title
    children.push(
      new Paragraph({
        text: data.title,
        heading: HeadingLevel.TITLE,
      })
    );

    // Note content
    if (data.content.trim()) {
      children.push(
        new Paragraph({
          text: 'Note Content',
          heading: HeadingLevel.HEADING_1,
        })
      );
      // Split content into paragraphs
      const contentParagraphs = data.content.split('\n').filter((p) => p.trim());
      for (const para of contentParagraphs) {
        children.push(new Paragraph({ text: para }));
      }
    }

    // Transcriptions
    for (const t of data.transcriptions) {
      children.push(
        new Paragraph({
          text: `Transcription - ${t.startTime.toLocaleString()}`,
          heading: HeadingLevel.HEADING_1,
        })
      );
      // Split transcription into paragraphs
      const textParagraphs = t.text.split('\n').filter((p) => p.trim());
      for (const para of textParagraphs) {
        children.push(new Paragraph({ text: para }));
      }

      for (const s of t.summaries) {
        children.push(
          new Paragraph({
            text: `Summary (${s.type})`,
            heading: HeadingLevel.HEADING_2,
          })
        );
        // Split summary into paragraphs
        const summaryParagraphs = s.text.split('\n').filter((p) => p.trim());
        for (const para of summaryParagraphs) {
          children.push(new Paragraph({ text: para }));
        }
      }
    }

    const doc = new Document({
      sections: [{ children }],
    });

    return Buffer.from(await Packer.toBuffer(doc));
  }

  formatToRtf(data: AggregatedNoteData): string {
    // RTF template-based generation
    const escapeRtf = (text: string) =>
      text
        .replace(/\\/g, '\\\\')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\n/g, '\\par ');

    let rtf = '{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Arial;}}';
    rtf += '\\f0';

    // Title
    rtf += `\\pard\\fs36\\b ${escapeRtf(data.title)}\\b0\\par\\par`;

    // Note content
    if (data.content.trim()) {
      rtf += `\\fs28\\b Note Content\\b0\\par`;
      rtf += `\\fs24 ${escapeRtf(data.content)}\\par\\par`;
    }

    // Transcriptions
    for (const t of data.transcriptions) {
      rtf += `\\fs28\\b Transcription - ${escapeRtf(t.startTime.toLocaleString())}\\b0\\par`;
      rtf += `\\fs24 ${escapeRtf(t.text)}\\par\\par`;

      for (const s of t.summaries) {
        rtf += `\\fs26\\b Summary (${escapeRtf(s.type)})\\b0\\par`;
        rtf += `\\fs24 ${escapeRtf(s.text)}\\par\\par`;
      }
    }

    rtf += '}';
    return rtf;
  }

  async formatToPdf(data: AggregatedNoteData): Promise<Buffer> {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let page = pdfDoc.addPage();
    const { width, height } = page.getSize();
    let y = height - 50;
    const margin = 50;
    const lineHeight = 16;
    const pageBottom = 50;

    const addNewPage = () => {
      page = pdfDoc.addPage();
      y = height - 50;
    };

    const drawText = (text: string, size: number, bold = false, indent = 0) => {
      const usedFont = bold ? boldFont : font;
      const maxWidth = width - 2 * margin - indent;
      const lines = this.wrapText(text, usedFont, size, maxWidth);

      for (const line of lines) {
        if (y < pageBottom) {
          addNewPage();
        }
        page.drawText(line, {
          x: margin + indent,
          y,
          size,
          font: usedFont,
          color: rgb(0, 0, 0),
        });
        y -= lineHeight;
      }
    };

    const addSpacing = (amount: number) => {
      y -= amount;
      if (y < pageBottom) {
        addNewPage();
      }
    };

    // Title
    drawText(data.title, 24, true);
    addSpacing(20);

    // Note content
    if (data.content.trim()) {
      drawText('Note Content', 16, true);
      addSpacing(10);
      drawText(data.content, 11);
      addSpacing(20);
    }

    // Transcriptions
    for (const t of data.transcriptions) {
      drawText(`Transcription - ${t.startTime.toLocaleString()}`, 16, true);
      addSpacing(10);
      drawText(t.text, 11);
      addSpacing(20);

      for (const s of t.summaries) {
        drawText(`Summary (${s.type})`, 14, true);
        addSpacing(8);
        drawText(s.text, 11);
        addSpacing(15);
      }
    }

    return Buffer.from(await pdfDoc.save());
  }

  private wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const lines: string[] = [];
    const paragraphs = text.split('\n');

    for (const paragraph of paragraphs) {
      if (!paragraph.trim()) {
        lines.push('');
        continue;
      }

      const words = paragraph.split(' ');
      let currentLine = '';

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const testWidth = font.widthOfTextAtSize(testLine, size);

        if (testWidth > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) {
        lines.push(currentLine);
      }
    }

    return lines;
  }

  async showSaveDialog(format: ExportFormat, defaultTitle: string): Promise<string | null> {
    const extensions: Record<ExportFormat, string> = {
      txt: 'txt',
      md: 'md',
      docx: 'docx',
      rtf: 'rtf',
      pdf: 'pdf',
    };

    const filterNames: Record<ExportFormat, string> = {
      txt: 'Text Files',
      md: 'Markdown Files',
      docx: 'Word Documents',
      rtf: 'Rich Text Files',
      pdf: 'PDF Files',
    };

    // Sanitize title for filename
    const sanitizedTitle = defaultTitle.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
    const defaultPath = path.join(
      app.getPath('documents'),
      `${sanitizedTitle}.${extensions[format]}`
    );

    const result = await dialog.showSaveDialog({
      title: 'Export Note',
      defaultPath,
      filters: [{ name: filterNames[format], extensions: [extensions[format]] }],
    });

    return result.canceled ? null : result.filePath || null;
  }
}
