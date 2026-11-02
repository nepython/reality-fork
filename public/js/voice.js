// Push-to-talk questions. Muse Voice Transcribe takes 16-bit mono PCM WAV at 16 or 24 kHz, so we capture raw samples
// with Web Audio and write the WAV ourselves (MediaRecorder only produces compressed formats).
export class Voice {
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}});
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.proc.onaudioprocess = e => this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(this.proc); this.proc.connect(this.ctx.destination);
  }

  async stop() {
    this.proc.disconnect(); this.stream.getTracks().forEach(t => t.stop());
    const rate = this.ctx.sampleRate; await this.ctx.close();
    const n = this.chunks.reduce((s, c) => s + c.length, 0), all = new Float32Array(n);
    let o = 0; for (const c of this.chunks) { all.set(c, o); o += c.length; }
    return wav(resample(all, rate, 24000), 24000);
  }
}

function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.floor(x.length * to / from), y = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) {
    // Average over the source window (a box filter) to avoid aliasing when downsampling 48 kHz → 24 kHz.
    const a = i * r, b = Math.min(x.length, a + r);
    let s = 0, c = 0; for (let j = Math.floor(a); j < b; j++) { s += x[j]; c++; }
    y[i] = c ? s / c : 0;
  }
  return y;
}

function wav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], {type: 'audio/wav'});
}
