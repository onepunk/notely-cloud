declare module '*.png' {
  const value: string;
  export default value;
}

declare module '*.jpg' {
  const value: string;
  export default value;
}

declare module '*.svg' {
  const value: string;
  export default value;
}

declare global {
  const __APP_VERSION__: string;
  interface Window {
    api: import('../../preload').PreloadApi;
  }
}
export {};
