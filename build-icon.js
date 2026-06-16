// Gera build/icon.ico (e icon.png) a partir de assets/icon.svg
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIcoMod = require('png-to-ico');
const pngToIco = pngToIcoMod.default || pngToIcoMod;

const svgPath = path.join(__dirname, 'assets', 'icon.svg');
const outDir = path.join(__dirname, 'build');
const sizes = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  const svg = fs.readFileSync(svgPath);
  fs.mkdirSync(outDir, { recursive: true });

  // PNGs em vários tamanhos (alta densidade para nitidez)
  const buffers = await Promise.all(
    sizes.map((s) => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer())
  );

  // PNG 256 para usos diversos
  await sharp(svg, { density: 384 }).resize(256, 256).png().toFile(path.join(outDir, 'icon.png'));

  // .ico combinando todos os tamanhos
  const ico = await pngToIco(buffers);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

  console.log('OK: build/icon.ico e build/icon.png gerados');
})().catch((err) => {
  console.error('Falha ao gerar ícone:', err);
  process.exit(1);
});
