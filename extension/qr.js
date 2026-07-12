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

  for (let index = 8; index < size - 8; index += 1) {
    setFunction(index, 6, index % 2 === 0);
    setFunction(6, index, index % 2 === 0);
  }

  setFunction(8, size - 8, true);
  drawFormatBits(0, modules, reserved);

  const data = encodeQrData(text, dataCodewords);
  const ecc = reedSolomon(data, ecCodewords);
  const bits = [...data, ...ecc].flatMap((byte) => {
    const output = [];
    for (let index = 7; index >= 0; index -= 1) output.push((byte >>> index) & 1);
    return output;
  });

  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const y = upward ? size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
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
  for (let deltaY = -1; deltaY <= 7; deltaY += 1) {
    for (let deltaX = -1; deltaX <= 7; deltaX += 1) {
      const inFinder = deltaX >= 0 && deltaX <= 6 && deltaY >= 0 && deltaY <= 6;
      const dark = inFinder && (
        deltaX === 0 || deltaX === 6 || deltaY === 0 || deltaY === 6 ||
        (deltaX >= 2 && deltaX <= 4 && deltaY >= 2 && deltaY <= 4)
      );
      setFunction(x + deltaX, y + deltaY, dark);
    }
  }
}

function drawAlignment(centerX, centerY, setFunction) {
  for (let deltaY = -2; deltaY <= 2; deltaY += 1) {
    for (let deltaX = -2; deltaX <= 2; deltaX += 1) {
      const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
      setFunction(centerX + deltaX, centerY + deltaY, distance === 0 || distance === 2);
    }
  }
}

function encodeQrData(text, capacity) {
  const bytes = [...new TextEncoder().encode(text)];
  if (bytes.length > capacity - 2) throw new Error("QR text is too long");

  const bits = [0, 1, 0, 0];
  for (let index = 7; index >= 0; index -= 1) bits.push((bytes.length >>> index) & 1);
  for (const byte of bytes) {
    for (let index = 7; index >= 0; index -= 1) bits.push((byte >>> index) & 1);
  }

  const maximumBits = capacity * 8;
  for (let index = 0, terminator = Math.min(4, maximumBits - bits.length); index < terminator; index += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let index = 0; index < bits.length; index += 8) {
    codewords.push(bits.slice(index, index + 8).reduce((value, bit) => (value << 1) | bit, 0));
  }
  for (let pad = 0xec; codewords.length < capacity; pad = pad === 0xec ? 0x11 : 0xec) codewords.push(pad);
  return codewords;
}

function reedSolomon(data, degree) {
  const generator = reedSolomonGenerator(degree);
  const result = Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let index = 0; index < degree; index += 1) result[index] ^= gfMultiply(generator[index], factor);
  }
  return result;
}

function reedSolomonGenerator(degree) {
  let polynomial = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = Array(polynomial.length + 1).fill(0);
    for (let offset = 0; offset < polynomial.length; offset += 1) {
      next[offset] ^= polynomial[offset];
      next[offset + 1] ^= gfMultiply(polynomial[offset], gfPow(index));
    }
    polynomial = next;
  }
  return polynomial.slice(1);
}

function gfPow(power) {
  let value = 1;
  for (let index = 0; index < power; index += 1) value = gfMultiply(value, 2);
  return value;
}

function gfMultiply(left, right) {
  let product = 0;
  for (let index = 7; index >= 0; index -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    if ((right >>> index) & 1) product ^= left;
  }
  return product & 0xff;
}

function drawFormatBits(bits, modules, reserved) {
  const size = modules.length;
  const set = (x, y, dark) => {
    modules[y][x] = dark ? 1 : 0;
    reserved[y][x] = true;
  };
  for (let index = 0; index <= 5; index += 1) set(8, index, (bits >>> index) & 1);
  set(8, 7, (bits >>> 6) & 1);
  set(8, 8, (bits >>> 7) & 1);
  set(7, 8, (bits >>> 8) & 1);
  for (let index = 9; index < 15; index += 1) set(14 - index, 8, (bits >>> index) & 1);
  for (let index = 0; index < 8; index += 1) set(size - 1 - index, 8, (bits >>> index) & 1);
  for (let index = 8; index < 15; index += 1) set(8, size - 15 + index, (bits >>> index) & 1);
  set(8, size - 8, true);
}

function formatBits(errorLevel, mask) {
  const generator = 0x537;
  const formatMask = 0x5412;
  const data = (errorLevel << 3) | mask;
  let bits = data << 10;
  while (bchDigit(bits) - bchDigit(generator) >= 0) bits ^= generator << (bchDigit(bits) - bchDigit(generator));
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
