export function createQrMatrix(text) {
  const version = 5;
  const size = version * 4 + 17;
  const dataCodewords = 108;
  const ecCodewords = 26;
  const mask = 0;
  const modules = Array.from({ length: size }, () => Array(size).fill(0));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));

  const setFunction = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark ? 1 : 0;
    reserved[y][x] = true;
  };

  drawFinder(0, 0, setFunction);
  drawFinder(size - 7, 0, setFunction);
  drawFinder(0, size - 7, setFunction);
  drawAlignment(30, 30, setFunction);

  for (let i = 8; i < size - 8; i += 1) {
    setFunction(i, 6, i % 2 === 0);
    setFunction(6, i, i % 2 === 0);
  }

  setFunction(8, size - 8, true);
  drawFormatBits(0, modules, reserved);

  const data = encodeQrData(text, dataCodewords);
  const ecc = reedSolomon(data, ecCodewords);
  const bits = [...data, ...ecc].flatMap((byte) => {
    const output = [];
    for (let i = 7; i >= 0; i -= 1) output.push((byte >>> i) & 1);
    return output;
  });

  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let dx = 0; dx < 2; dx += 1) {
        const x = right - dx;
        if (reserved[y][x]) continue;
        modules[y][x] = bitIndex < bits.length ? bits[bitIndex] : 0;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!reserved[y][x] && (x + y) % 2 === 0) modules[y][x] ^= 1;
    }
  }

  drawFormatBits(formatBits(1, mask), modules, reserved);
  return modules;
}

function drawFinder(x, y, setFunction) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const inFinder = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark =
        inFinder &&
        (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      setFunction(x + dx, y + dy, dark);
    }
  }
}

function drawAlignment(centerX, centerY, setFunction) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(centerX + dx, centerY + dy, distance === 0 || distance === 2);
    }
  }
}

function encodeQrData(text, capacity) {
  const bytes = [...new TextEncoder().encode(text)];
  if (bytes.length > capacity - 2) throw new Error("QR text is too long");

  const bits = [0, 1, 0, 0];
  for (let i = 7; i >= 0; i -= 1) bits.push((bytes.length >>> i) & 1);
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  }

  const maxBits = capacity * 8;
  for (let i = 0, terminator = Math.min(4, maxBits - bits.length); i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  }
  for (let pad = 0xec; codewords.length < capacity; pad = pad === 0xec ? 0x11 : 0xec) {
    codewords.push(pad);
  }
  return codewords;
}

function reedSolomon(data, degree) {
  const generator = reedSolomonGenerator(degree);
  const result = Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) {
      result[i] ^= gfMultiply(generator[i], factor);
    }
  }
  return result;
}

function reedSolomonGenerator(degree) {
  let polynomial = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = Array(polynomial.length + 1).fill(0);
    for (let j = 0; j < polynomial.length; j += 1) {
      next[j] ^= polynomial[j];
      next[j + 1] ^= gfMultiply(polynomial[j], gfPow(i));
    }
    polynomial = next;
  }
  return polynomial.slice(1);
}

function gfPow(power) {
  let value = 1;
  for (let i = 0; i < power; i += 1) value = gfMultiply(value, 2);
  return value;
}

function gfMultiply(left, right) {
  let product = 0;
  for (let i = 7; i >= 0; i -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    if ((right >>> i) & 1) product ^= left;
  }
  return product & 0xff;
}

function drawFormatBits(bits, modules, reserved) {
  const size = modules.length;
  const set = (x, y, dark) => {
    modules[y][x] = dark ? 1 : 0;
    reserved[y][x] = true;
  };
  for (let i = 0; i <= 5; i += 1) set(8, i, (bits >>> i) & 1);
  set(8, 7, (bits >>> 6) & 1);
  set(8, 8, (bits >>> 7) & 1);
  set(7, 8, (bits >>> 8) & 1);
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, (bits >>> i) & 1);
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, (bits >>> i) & 1);
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, (bits >>> i) & 1);
  set(8, size - 8, true);
}

function formatBits(errorLevel, mask) {
  const generator = 0x537;
  const formatMask = 0x5412;
  const data = (errorLevel << 3) | mask;
  let bits = data << 10;
  while (bchDigit(bits) - bchDigit(generator) >= 0) {
    bits ^= generator << (bchDigit(bits) - bchDigit(generator));
  }
  return ((data << 10) | bits) ^ formatMask;
}

function bchDigit(value) {
  let digit = 0;
  while (value !== 0) {
    digit += 1;
    value >>>= 1;
  }
  return digit;
}
