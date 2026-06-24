export const STORAGE_KEY = "splob.settings";
export const PROFILE_KEY = "splob.profile";
export const CLIENT_ID_KEY = "splob.clientId";
export const WHOLEGRAIN_ACCOUNTS_URL = "https://wholegrainstudios.co.uk/accounts/link";

export const PLAYER_COLORS = {
  cyan: { name: "Cyan", paint: "#00b7e8", dark: "#08749a", light: "#77e8ff" },
  magenta: { name: "Magenta", paint: "#ec159b", dark: "#9b0f69", light: "#ff79cd" },
  yellow: { name: "Yellow", paint: "#f4d12f", dark: "#b99008", light: "#fff078" },
  green: { name: "Green", paint: "#26c95f", dark: "#16833f", light: "#82eea8" }
};

export const COLOR_ORDER = ["cyan", "magenta", "yellow", "green"];
export const AI_NAMES = ["Drip", "Daub", "Smudge", "Mottle", "Gloss", "Dabble"];

export const POWER_UPS = [
  { id: "boost", name: "Boost", tier: 1, iconSrc: "/assets/powerups/boost.png" },
  { id: "grow", name: "Grow", tier: 1, iconSrc: "/assets/powerups/grow.png" },
  { id: "messy", name: "Messy", tier: 2, iconSrc: "/assets/powerups/messy.png" },
  { id: "splat", name: "Splat", tier: 2, iconSrc: "/assets/powerups/splat.png" },
  { id: "shield", name: "Shield", tier: 2, iconSrc: "/assets/powerups/shield.png" },
  { id: "paintball", name: "Paintball", tier: 2, iconSrc: "/assets/powerups/paintball.png" },
  { id: "slow", name: "Slow", tier: 2, iconSrc: "/assets/powerups/slow.png" },
  { id: "shrink", name: "Shrink", tier: 3, iconSrc: "/assets/powerups/shrink.png" },
  { id: "reverse", name: "Reverse", tier: 3, iconSrc: "/assets/powerups/reverse.png" },
  { id: "freeze", name: "Freeze", tier: 3, iconSrc: "/assets/powerups/freeze.png" },
  { id: "banana", name: "Banana", tier: 3, iconSrc: "/assets/powerups/banana.png" },
  { id: "spiky", name: "Spiky Ball", tier: 4, iconSrc: "/assets/powerups/spiky.png" }
];

export const GAME_SECONDS = 60;
export const COUNTDOWN_LABELS = ["3", "2", "1", "Splob!"];
