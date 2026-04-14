/**
 * Tag types for renderer-side usage
 */

export interface Tag {
  id: string;
  userId: string | null;
  name: string;
  color: string | null;
  sortIndex: number;
  createdAt: Date;
  updatedAt: Date;
  deleted: boolean;
  noteCount?: number;
}

export interface NoteTag {
  id: string;
  noteId: string;
  tagId: string;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deleted: boolean;
}

export interface CreateTagInput {
  name: string;
  color?: string;
}

export interface UpdateTagInput {
  id: string;
  name?: string;
  color?: string | null;
}
