export const cloudHubFavoriteAssetsStorageKey = "cloudhub-tools-favorite-assets";
export const cloudHubFavoriteAssetOrderStorageKey = "cloudhub-tools-favorite-asset-order";
export const cloudHubAssetNotesStorageKey = "cloudhub-tools-asset-notes";
export const cloudHubAssetOrderStorageKey = "cloudhub-tools-asset-order";
export const cloudHubAssetDisplayNamesStorageKey = "cloudhub-tools-asset-display-names";
export const cloudHubManagedHostOrderStorageKey = "cloudhub-tools-managed-host-order";
export const cloudHubManagedHostGroupOrderStorageKey = "cloudhub-tools-managed-host-group-order";
export const cloudHubTerminalThemeStorageKey = "cloudhub-tools-terminal-theme";

export const terminalThemes = {
  dark: {
    label: "深色",
    background: "#000000", foreground: "#f5f5f5", cursor: "#f5f5f5", selectionBackground: "#295b91",
    black: "#000000", brightBlack: "#8a8a8a", red: "#ff6b6b", brightRed: "#ff8b8b", green: "#61d095", brightGreen: "#7ff0b0", yellow: "#f6d365", brightYellow: "#ffe38c", blue: "#70b7ff", brightBlue: "#9dceff", magenta: "#d29cff", brightMagenta: "#e5bfff", cyan: "#66d9ef", brightCyan: "#9beaff", white: "#e6e6e6", brightWhite: "#ffffff",
  },
  blue: {
    label: "蓝墨",
    background: "#071523", foreground: "#dceeff", cursor: "#7fc8ff", selectionBackground: "#22527d",
    black: "#071523", brightBlack: "#607d98", red: "#ff7788", brightRed: "#ff9dab", green: "#69dca5", brightGreen: "#9befc2", yellow: "#f4cf72", brightYellow: "#ffe39c", blue: "#6ab6ff", brightBlue: "#9ad2ff", magenta: "#d4a5ff", brightMagenta: "#e8c7ff", cyan: "#65d7e8", brightCyan: "#a7f0f7", white: "#c6dceb", brightWhite: "#ffffff",
  },
  green: {
    label: "松绿",
    background: "#081914", foreground: "#d5f2df", cursor: "#7ce6a4", selectionBackground: "#1e5741",
    black: "#081914", brightBlack: "#668b7b", red: "#f07878", brightRed: "#ffaaaa", green: "#5fd492", brightGreen: "#8df1bb", yellow: "#e8c96a", brightYellow: "#ffe596", blue: "#68bfff", brightBlue: "#9bd5ff", magenta: "#d1a7ff", brightMagenta: "#e4c6fb", cyan: "#65d8c5", brightCyan: "#a4f4e5", white: "#cce4d5", brightWhite: "#ffffff",
  },
  amber: {
    label: "暖琥珀",
    background: "#1a1208", foreground: "#f8ead2", cursor: "#ffd080", selectionBackground: "#65451a",
    black: "#1a1208", brightBlack: "#927957", red: "#ef7e72", brightRed: "#ffafa2", green: "#9ed27d", brightGreen: "#c6ef9e", yellow: "#f2c35f", brightYellow: "#ffe19a", blue: "#79b7ed", brightBlue: "#a9d5ff", magenta: "#d6a2ed", brightMagenta: "#eac5fb", cyan: "#6ed3c7", brightCyan: "#aaf0e6", white: "#e7d4b5", brightWhite: "#fff7e9",
  },
} as const;

export type TerminalThemeName = keyof typeof terminalThemes;
