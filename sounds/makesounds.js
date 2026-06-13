const fs = require('fs');
const path = require('path');

function writeWav(filename, frequency, duration, volume = 0.3) {
  const sampleRate = 44100;
  const numSamples = Math.floor(sampleRate * duration);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // WAV header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.min(1, (duration - t) / 0.1); // fade out last 100ms
    const sample = Math.sin(2 * Math.PI * frequency * t) * volume * envelope * 32767;
    buffer.writeInt16LE(Math.round(sample), 44 + i * 2);
  }

  fs.writeFileSync(path.join(__dirname, 'sounds', filename), buffer);
  console.log('wrote', filename);
}

fs.mkdirSync(path.join(__dirname, 'sounds'), { recursive: true });

// pounce sound: quick descending two-tone
writeWav('pounce.wav', 880, 0.15);
writeWav('lockin.wav', 523, 0.3); // C5 chime for break end