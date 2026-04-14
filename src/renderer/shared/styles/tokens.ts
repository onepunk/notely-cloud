// Visual tokens specific to the Notely app UI
// Keep non-Fluent constants here instead of inside components

export const BINDER_COLORS = [
  '#E57373',
  '#F06292',
  '#BA68C8',
  '#9575CD',
  '#64B5F6',
  '#4DD0E1',
  '#4DB6AC',
  '#81C784',
  '#DCE775',
  '#FFD54F',
  '#FFB74D',
  '#A1887F',
  '#90A4AE',
] as const;

export const BINDER_COLOR_PRESETS = BINDER_COLORS.slice(0, 8);

// Curated list of 50 most popular and relevant icons for binders
// Note: FileText, Calendar, Star, Archive, Trash2 are reserved for system navigation
export const BINDER_ICONS = [
  // Organization & Files
  'Folder',
  'FolderOpen',
  'File',
  'Inbox',
  'Bookmark',
  'Tag',
  'Flag',
  'Pin',
  // Time & Planning
  'Clock',
  'Bell',
  'CheckSquare',
  'ListTodo',
  'Timer',
  'CalendarDays',
  // Learning & Knowledge
  'Book',
  'BookOpen',
  'GraduateCap',
  'Lightbulb',
  'Brain',
  'Library',
  'Newspaper',
  // Work & Projects
  'Briefcase',
  'Target',
  'TrendingUp',
  'BarChart',
  'PieChart',
  'Zap',
  'Rocket',
  'Code',
  'Terminal',
  // Creative
  'Palette',
  'Pen',
  'Image',
  'Camera',
  'Music',
  // Science & Tech
  'FlaskConical',
  'Microscope',
  'Atom',
  'Settings',
  'Database',
  'Cpu',
  // Communication & Social
  'Mail',
  'MessageCircle',
  'Phone',
  'Users',
  'User',
  'Heart',
  // Navigation & Common
  'Home',
  'Search',
  'Globe',
] as const;
