import { applyTheme } from "./css";
import { DEFAULT_THEME_IDS, findTheme } from "./registry";
import type { Theme } from "./types";

const STORAGE_KEY = "code-blueprint-appearance";
const DARK_QUERY = "(prefers-color-scheme: dark)";

interface AppearanceState {
  /** Theme chosen by hand (used when not following the system). */
  themeId: string;
  followSystem: boolean;
  /** Themes used when following the system, for its light and dark modes. */
  lightId: string;
  darkId: string;
  /** Live OS setting; not persisted. */
  systemDark: boolean;
}

type Listener = (theme: Theme) => void;

/** The theme currently in effect for a given state. */
export function resolveTheme(state: AppearanceState): Theme {
  const id = state.followSystem ? (state.systemDark ? state.darkId : state.lightId) : state.themeId;
  return findTheme(id) ?? findTheme(DEFAULT_THEME_IDS[state.systemDark ? "dark" : "light"])!;
}

function load(): Partial<AppearanceState> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<AppearanceState>;
  } catch {
    return {};
  }
}

const media = window.matchMedia(DARK_QUERY);
// Dark by default: the map is designed for a dark canvas, light themes are opt-in.
let state: AppearanceState = {
  themeId: DEFAULT_THEME_IDS.dark,
  followSystem: false,
  lightId: DEFAULT_THEME_IDS.light,
  darkId: DEFAULT_THEME_IDS.dark,
  ...load(),
  systemDark: media.matches,
};
const listeners = new Set<Listener>();

function commit(next: Partial<AppearanceState>) {
  state = { ...state, ...next };
  try {
    const { themeId, followSystem, lightId, darkId } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ themeId, followSystem, lightId, darkId }));
  } catch {
    // Storage may be unavailable (private mode): the choice simply isn't remembered.
  }
  const theme = resolveTheme(state);
  applyTheme(theme);
  for (const listener of listeners) listener(theme);
}

export const themeStore = {
  get state(): Readonly<AppearanceState> {
    return state;
  },
  active: (): Theme => resolveTheme(state),
  /** Picking a theme is an explicit choice: it applies right away and stops following the system. */
  select(id: string) {
    if (findTheme(id)) commit({ themeId: id, followSystem: false });
  },
  setFollowSystem(follow: boolean) {
    const current = resolveTheme(state);
    if (follow) commit({ followSystem: true, ...(current.scheme === "dark" ? { darkId: current.id } : { lightId: current.id }) });
    else commit({ followSystem: false, themeId: current.id });
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

media.addEventListener("change", (event) => commit({ systemDark: event.matches }));
applyTheme(resolveTheme(state));
