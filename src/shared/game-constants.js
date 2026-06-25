export const ARENA_WIDTH = 1280;
export const ARENA_HEIGHT = 720;
export const GAME_SECONDS = 60;

export const PLAYER_COLORS = {
  cyan: { name: "Cyan", paint: "#00b7e8", dark: "#08749a", light: "#77e8ff" },
  magenta: { name: "Magenta", paint: "#ec159b", dark: "#9b0f69", light: "#ff79cd" },
  yellow: { name: "Yellow", paint: "#f4d12f", dark: "#b99008", light: "#fff078" },
  green: { name: "Green", paint: "#26c95f", dark: "#16833f", light: "#82eea8" }
};

export const COLOR_ORDER = ["cyan", "magenta", "yellow", "green"];

export const PLAYER_RADIUS = 72;
export const BASE_SPEED = 296;
export const MAX_MOVE_SPEED = BASE_SPEED * 2;
export const ACCELERATION_PER_SECOND = (MAX_MOVE_SPEED / 2.5) * 2.5 * 1.3;
export const DECELERATION_PER_SECOND = ACCELERATION_PER_SECOND * 1.8;
export const BODY_HALF_WIDTH = PLAYER_RADIUS * 1.18;
export const BODY_HALF_HEIGHT = PLAYER_RADIUS * 0.84;

export const SERVER_TICK_RATE = 30;
export const SNAPSHOT_RATE = 20;
export const PAINT_BATCH_RATE = 20;
export const SCORE_UPDATE_RATE = 4;
export const SCORE_GRID_WIDTH = 320;
export const SCORE_GRID_HEIGHT = 180;
