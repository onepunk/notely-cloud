import { app, ipcMain, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';

import { logger } from '../logger';

/**
 * Builds and manages the native macOS application menu.
 * Only instantiated on darwin. Sends IPC events to the renderer
 * when custom menu items are clicked.
 */
export class MacMenuManager {
  private currentNoteId: string | null = null;

  constructor(private webContents: WebContents) {
    this.buildMenu();
    this.registerIPC();
  }

  private registerIPC(): void {
    ipcMain.on('menu:updateState', (_event, state: { noteId: string | null }) => {
      if (state.noteId !== this.currentNoteId) {
        this.currentNoteId = state.noteId;
        this.buildMenu();
      }
    });
  }

  private send(channel: string, ...args: unknown[]): void {
    if (!this.webContents.isDestroyed()) {
      this.webContents.send(channel, ...args);
    }
  }

  private buildMenu(): void {
    const hasNote = this.currentNoteId !== null;

    const template: MenuItemConstructorOptions[] = [
      // -- App menu --
      {
        label: app.name,
        submenu: [
          {
            label: 'About Notely',
            click: () => this.send('menu:navigate', '/settings/about'),
          },
          { type: 'separator' },
          {
            label: 'Settings',
            accelerator: 'CmdOrCtrl+,',
            click: () => this.send('menu:navigate', '/settings/general'),
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      // -- File menu --
      {
        label: 'File',
        submenu: [
          {
            label: 'New Note',
            accelerator: 'CmdOrCtrl+N',
            click: () => this.send('menu:newNote'),
          },
          { type: 'separator' },
          {
            label: 'Export',
            enabled: hasNote,
            submenu: [
              {
                label: 'Plain Text (.txt)',
                enabled: hasNote,
                click: () => this.send('menu:export', 'txt'),
              },
              {
                label: 'Markdown (.md)',
                enabled: hasNote,
                click: () => this.send('menu:export', 'md'),
              },
              {
                label: 'Word Document (.docx)',
                enabled: hasNote,
                click: () => this.send('menu:export', 'docx'),
              },
              {
                label: 'Rich Text (.rtf)',
                enabled: hasNote,
                click: () => this.send('menu:export', 'rtf'),
              },
              {
                label: 'PDF (.pdf)',
                enabled: hasNote,
                click: () => this.send('menu:export', 'pdf'),
              },
            ],
          },
        ],
      },
      // -- Edit menu (role-based for standard Cmd+C/V/X/Z/A) --
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      // -- View menu --
      {
        label: 'View',
        submenu: [
          {
            label: 'Transcriptions',
            click: () => this.send('menu:openTranscriptions'),
          },
          { type: 'separator' },
          {
            label: 'Zoom In',
            accelerator: 'CmdOrCtrl+=',
            click: () => this.send('menu:fontZoomIn'),
          },
          {
            label: 'Zoom Out',
            accelerator: 'CmdOrCtrl+-',
            click: () => this.send('menu:fontZoomOut'),
          },
          {
            label: 'Actual Size',
            accelerator: 'CmdOrCtrl+0',
            click: () => this.send('menu:fontZoomReset'),
          },
        ],
      },
      // -- Window menu --
      {
        label: 'Window',
        role: 'windowMenu',
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);

    logger.debug('MacMenuManager: Menu rebuilt', { hasNote });
  }
}
