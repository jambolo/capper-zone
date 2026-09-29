const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const type = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/^\uFEFF/, ''));
const wordmark = type('wordmark.json');
const tagline = type('tagline.json');
const colors = { navy: '#101B2D', blue: '#2667FF', coral: '#FF6B5E', white: '#F5F7FB' };

// These three paths are the shared master for every logo and icon export.
const rows = [
  'M38 0H356C405 0 435 34 435 83C435 130 415 160 370 175L435 286H360L265 123H320C334 123 344 114 344 100C344 86 334 76 320 76H88Z',
  'M22 103H215C229 103 236 109 243 121L335 286H267L202 179C196 169 190 165 178 165H64Z',
  'M0 184H162C176 184 185 190 192 202L241 286H172L150 253C146 246 140 244 131 244H40Z',
];

const n = (x) => Number(x.toFixed(6));
const group = (transform, content) => `<g transform="${transform}">${content}</g>`;
function mark(ink = colors.white, mono = false) {
  return rows.map((d, i) => `<path fill="${mono ? ink : [ink, colors.blue, colors.coral][i]}" d="${d}"/>`).join('');
}
function lettering(x, y, ink, width = 420, height = 104) {
  const slant = Math.tan(12 * Math.PI / 180);
  const sx = (width - height * slant) / wordmark.width;
  const sy = height / wordmark.height;
  return `<path fill="${ink}" fill-rule="nonzero" transform="matrix(${n(sx)} 0 ${n(-slant * sy)} ${n(sy)} ${n(x + slant * height)} ${y})" d="${wordmark.path}"/>`;
}
function line(x, y, ink, width = 420) {
  return `<path fill="${ink}" fill-rule="nonzero" transform="translate(${x} ${y}) scale(${n(width / tagline.width)})" d="${tagline.path}"/>`;
}
function lockup(ink, mono, withTagline) {
  if (withTagline) return group('translate(32 35) scale(.49)', mark(ink, mono)) + lettering(268, 29, ink) + line(268, 151, ink);
  return group('translate(32 28) scale(.42)', mark(ink, mono)) + lettering(242, 36, ink);
}
function svg(width, height, body, title, background) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title"><title id="title">${title}</title>${background ? `<path fill="${background}" d="M0 0H${width}V${height}H0Z"/>` : ''}${body}</svg>\n`;
}
function save(relative, data) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}

async function main() {
  const variants = [
    ['primary', colors.white, false],
    ['on-light', colors.navy, false],
    ['mono-white', '#FFFFFF', true],
    ['mono-black', '#000000', true],
  ];
  for (const [name, ink, mono] of variants) {
    const artwork = svg(694, 176, lockup(ink, mono, false), 'Rally Row');
    save(`svg/rally-row-${name}.svg`, artwork);
    save(`png/rally-row-${name}.png`, await sharp(Buffer.from(artwork), { density: 288 }).png().toBuffer());
    save(`svg/rally-row-mark-${name}.svg`, svg(499, 350, group('translate(32 32)', mark(ink, mono)), 'Rally Row mark'));
    if (!mono) {
      const signed = svg(720, 208, lockup(ink, mono, true), `Rally Row. ${tagline.text}`);
      save(`svg/rally-row-tagline-${name}.svg`, signed);
      save(`png/rally-row-tagline-${name}.png`, await sharp(Buffer.from(signed), { density: 288 }).png().toBuffer());
    }
  }
  const primary = svg(720, 208, lockup(colors.white, false, true), `Rally Row. ${tagline.text}`, colors.navy);
  save('svg/rally-row-tagline-on-navy.svg', primary);
  save('png/rally-row-tagline-on-navy.png', await sharp(Buffer.from(primary), { density: 288 }).png().toBuffer());

  const stacked = group('translate(142.5 64)', mark()) + lettering(64, 404, colors.white, 592, 148) + line(89, 586, colors.white, 542);
  save('svg/rally-row-stacked-primary.svg', svg(720, 684, stacked, `Rally Row. ${tagline.text}`));
  const stackedNavy = svg(720, 684, stacked, `Rally Row. ${tagline.text}`, colors.navy);
  save('png/rally-row-stacked-on-navy.png', await sharp(Buffer.from(stackedNavy), { density: 288 }).png().toBuffer());

  const tile = `<rect width="64" height="64" rx="13" fill="${colors.navy}"/>` + group('translate(6 15) scale(.11954)', mark());
  const favicon = svg(64, 64, tile, 'Rally Row');
  save('favicon/favicon.svg', favicon);
  const sizes = [16, 32, 48, 64, 180, 192, 512];
  const icons = new Map();
  for (const size of sizes) {
    const input = size === 180
      ? svg(64, 64, `<path fill="${colors.navy}" d="M0 0H64V64H0Z"/>` + group('translate(8 16.2) scale(.110345)', mark()), 'Rally Row')
      : favicon;
    const data = await sharp(Buffer.from(input), { density: 768 }).resize(size, size).png().toBuffer();
    icons.set(size, data);
    save(size === 180 ? 'favicon/apple-touch-icon.png' : `favicon/favicon-${size}.png`, data);
  }

  // ICO embeds the same PNG renders, preserving alpha at each native size.
  const icoSizes = [16, 32, 48];
  const header = Buffer.alloc(6 + icoSizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(icoSizes.length, 4);
  let offset = header.length;
  icoSizes.forEach((size, i) => {
    const p = 6 + i * 16;
    const bytes = icons.get(size);
    header[p] = size;
    header[p + 1] = size;
    header.writeUInt16LE(1, p + 4);
    header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(bytes.length, p + 8);
    header.writeUInt32LE(offset, p + 12);
    offset += bytes.length;
  });
  save('favicon/favicon.ico', Buffer.concat([header, ...icoSizes.map(size => icons.get(size))]));

  const label = (x, y, text, ink = colors.navy) => `<text x="${x}" y="${y}" font-family="Arial,sans-serif" font-size="15" letter-spacing="2" fill="${ink}">${text}</text>`;
  let proof = `<path fill="${colors.white}" d="M0 0H1280V1000H0Z"/><path fill="${colors.navy}" d="M0 0H1280V600H0Z"/>`;
  proof += label(64, 56, 'RALLY ROW / PRODUCTION IDENTITY', colors.white);
  proof += group('translate(122 130) scale(1.44)', lockup(colors.white, false, true));
  proof += label(64, 462, 'PRIMARY MARK', colors.white);
  proof += group('translate(64 492) scale(.7)', tile);
  proof += label(158, 505, 'OFF-WHITE + ELECTRIC BLUE + CORAL', colors.white);
  proof += label(158, 536, 'ON MIDNIGHT NAVY', colors.white);
  proof += label(64, 650, 'SECONDARY / LIGHT SURFACES');
  proof += group('translate(42 665) scale(.75)', lockup(colors.navy, false, true));
  proof += label(696, 650, 'ONE COLOR');
  proof += group('translate(680 672) scale(.75)', lockup('#000000', true, false));
  proof += `<path fill="#CFD6E2" d="M64 856H1216V857H64Z"/>`;
  proof += label(64, 902, 'FAVICON / ACTUAL PIXEL SIZES');
  let x = 510;
  for (const size of [16, 32, 48, 64]) {
    proof += `<image x="${x}" y="${908 - size / 2}" width="${size}" height="${size}" href="data:image/png;base64,${icons.get(size).toString('base64')}"/>`;
    proof += label(x, 972, `${size}`);
    x += 160;
  }
  save('preview.png', await sharp(Buffer.from(svg(1280, 1000, proof, 'Rally Row production artwork proof'))).png().toBuffer());
  console.log('Created vector logos, outlined tagline lockups, PNG exports, favicon sizes, ICO, and preview.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
