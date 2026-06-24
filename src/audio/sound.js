export class Sound {
  static volume = 0.8;
  static context = null;

  static configure(volume) {
    Sound.volume = Math.max(0, Math.min(1, Number(volume) || 0));
  }

  static play(kind = "tap", value = 0) {
    if (!Sound.volume) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    Sound.context ||= new AudioContext();
    const ctx = Sound.context;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const map = {
      tap: [440, 0.035],
      power: [700, 0.12],
      shuffle: [520 + Math.random() * 560, 0.045],
      thud: [95, 0.18],
      splat: [150, 0.16],
      swishoo: [620, 0.24],
      countdown: [520 + (6 - Number(value || 1)) * 115, 0.12],
      score: [180 + Number(value || 0) * 95, 0.16],
      fanfare: [920, 0.34],
      win: [880, 0.22]
    };
    const [freq, duration] = map[kind] || map.tap;
    osc.frequency.value = freq;
    if (kind === "swishoo" || kind === "fanfare") {
      osc.frequency.setValueAtTime(freq * 0.65, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.35, ctx.currentTime + duration);
    }
    osc.type = kind === "splat" || kind === "thud" || kind === "score" ? "sawtooth" : "triangle";
    gain.gain.setValueAtTime(Sound.volume * (kind === "thud" || kind === "score" ? 0.24 : 0.16), ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  }
}
