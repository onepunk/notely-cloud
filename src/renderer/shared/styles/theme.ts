import { webDarkTheme, webLightTheme } from '@fluentui/react-components';

// Central place for appearance tokens. Keep logic out of layout/components.
// Extend Fluent 2 light theme with subtle neutrals.
export const notelyTheme = {
  ...webLightTheme,

  // Neutral palette (rgba for easy tweaks)
  colorNeutralForeground1: 'rgba(31, 35, 40, 1)',
  colorNeutralForeground2: 'rgba(87, 96, 106, 1)',
  colorNeutralBackground1: 'rgba(243, 243, 243, 1)',
  colorNeutralBackground2: 'rgba(235, 235, 235, 1)',
  colorNeutralStroke1: 'rgba(208, 208, 208, 1)',

  // Primary button (brand) → neutral greys
  colorBrandBackground: 'rgb(200, 200, 200)',
  colorBrandBackgroundHover: 'rgba(209, 209, 209, 1)',
  colorBrandBackgroundPressed: 'rgba(189, 189, 189, 1)',
  colorNeutralForegroundOnBrand: 'rgba(31, 35, 40, 1)',
  borderRadiusMedium: '10px',
  shadow4: '0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.08)',
  fontFamilyBase: 'Inter, Segoe UI Variable, system-ui, -apple-system, Segoe UI, Roboto, Arial',
} as const;

export type AppTheme = typeof notelyTheme;

export const notelyDarkTheme = {
  ...webDarkTheme,
  colorNeutralForeground1: 'rgba(229, 229, 229, 1)',
  colorNeutralForeground2: 'rgba(190, 190, 190, 1)',
  colorNeutralBackground1: 'rgba(26, 26, 26, 1)',
  colorNeutralBackground2: 'rgba(36, 36, 36, 1)',
  colorNeutralStroke1: 'rgba(60, 60, 60, 1)',
  colorBrandBackground: 'rgb(71, 83, 96)',
  colorBrandBackgroundHover: 'rgb(82, 94, 108)',
  colorBrandBackgroundPressed: 'rgb(62, 74, 86)',
  colorNeutralForegroundOnBrand: 'rgba(255, 255, 255, 0.92)',
  borderRadiusMedium: '10px',
  shadow4: '0 0 0 rgba(0,0,0,0.0)',
  fontFamilyBase: 'Inter, Segoe UI Variable, system-ui, -apple-system, Segoe UI, Roboto, Arial',
} as const;

export type DarkAppTheme = typeof notelyDarkTheme;
