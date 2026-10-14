import { defineTheme } from "../define";

export default defineTheme({
  id: "holo",
  name: "Holo",
  description: "Deep space navy, cyan hologram glow, glass panels. The map's native look.",
  scheme: "dark",
  colors: {
    canvas: "#050A14",
    surface: "#0B1626CC",
    surfaceHover: "#13243BDD",
    border: "#3FD8FF33",
    textPrimary: "#E6F7FF",
    textSecondary: "#9CC3D9",
    textMuted: "#5F8399",
    accent: "#3FD8FF",
    success: "#3DFFB0",
    warning: "#FFC24B",
    danger: "#FF4D6D",
  },
  radius: { control: "10px", tile: "12px", card: "16px", pill: "9999px" },
  shadow: {
    card: "0 0 0 1px rgb(63 216 255 / 0.10), 0 12px 40px -12px rgb(0 0 0 / 0.7)",
    overlay: "0 0 0 1px rgb(63 216 255 / 0.18), 0 0 48px -8px rgb(63 216 255 / 0.25)",
    control: "none",
    inset: "inset 0 0 12px rgb(63 216 255 / 0.15)",
  },
  effects: { surfaceBackdrop: "blur(18px) saturate(140%)", canvasImage: "none" },
  fonts: {
    sans: '"Space Grotesk", Inter, -apple-system, "Segoe UI", sans-serif',
    mono: '"JetBrains Mono", SFMono-Regular, Consolas, monospace',
  },
});
