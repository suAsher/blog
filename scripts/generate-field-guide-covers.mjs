/** Original explanatory diagrams. All numbers are constructed teaching values. */
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";

const output = new URL("../public/images/field-guides/", import.meta.url);
const originals = new URL("../examples/field-guides/images/", import.meta.url);
const colors = {
  ink: "#eaf2ff",
  muted: "#a3b3ca",
  mint: "#a1f0d1",
  blue: "#8dbfee",
  violet: "#b8a3f2",
  red: "#f4b1a5",
};
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
function text(x, y, value, size = 13, color = colors.muted, anchor = "start") {
  return `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" text-anchor="${anchor}">${escape(value)}</text>`;
}
function path(d, color = colors.muted, arrow = true, dashed = false) {
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" ${arrow ? 'marker-end="url(#arrow)"' : ""} ${dashed ? 'stroke-dasharray="4 5"' : ""}/>`;
}
function box(x, y, width, height, stroke = "#33455c", fill = "#111d2e") {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14" fill="${fill}" stroke="${stroke}"/>`;
}
function frame(kicker, title, subline, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400">
    <defs>
      <linearGradient id="background" x2="1" y2="1"><stop stop-color="#0b1220"/><stop offset="1" stop-color="#11192a"/></linearGradient>
      <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#91b0d2" stroke-opacity=".07"/></pattern>
      <pattern id="queue" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#1c293d"/><path d="M-2 2L2-2M0 8L8 0M6 10L10 6" stroke="#8194ae" stroke-opacity=".4"/></pattern>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10" fill="none" stroke="#a3b3ca" stroke-width="1.5"/></marker>
    </defs>
    <rect width="1200" height="400" fill="url(#background)"/>
    <rect width="1200" height="400" fill="url(#grid)"/>
    <g font-family="Arial, Helvetica, sans-serif">
      ${text(52, 38, kicker, 11, colors.mint)}
      ${text(52, 80, title, 29, colors.ink)}
      ${text(52, 109, subline, 13)}
      ${body}
      <path d="M52 361H1148" stroke="#33455c" stroke-opacity=".7"/>
      ${text(52, 384, "ASHER / FIELD GUIDES", 10)}
      ${text(1148, 384, "ORIGINAL TEACHING DIAGRAM · NOT A PRODUCTION TRACE", 10, colors.muted, "end")}
    </g>
  </svg>`;
}

function inference() {
  const origin = 290,
    scale = 32;
  const row = (label, y, queue, prefill, decode) => {
    const prefillX = origin + queue * scale;
    const decodeX = prefillX + prefill * scale;
    return `${text(60, y + 26, label, 14, colors.ink)}
      <rect x="${origin}" y="${y}" width="${24 * scale}" height="40" rx="6" fill="#0a111d" stroke="#25374d"/>
      ${queue ? `<rect x="${origin}" y="${y}" width="${queue * scale}" height="40" rx="5" fill="url(#queue)"/>${text(origin + (queue * scale) / 2, y + 25, "QUEUE", 11, colors.muted, "middle")}` : ""}
      <rect x="${prefillX}" y="${y}" width="${prefill * scale}" height="40" rx="4" fill="${colors.mint}"/>
      ${text(prefillX + (prefill * scale) / 2, y + 25, "PREFILL", 11, "#10291f", "middle")}
      <rect x="${decodeX}" y="${y}" width="${decode * scale}" height="40" rx="4" fill="${colors.violet}"/>
      ${text(decodeX + (decode * scale) / 2, y + 25, "DECODE", 11, "#221b36", "middle")}`;
  };
  const ticks = [0, 4, 12, 16, 24]
    .map(
      (value) =>
        `${path(`M${origin + value * scale} 153V302`, "#33455c", false, true)}${text(origin + value * scale, 327, String(value), 11, colors.muted, "middle")}`,
    )
    .join("");
  return frame(
    "01 / INFERENCE SYSTEMS",
    "Where the wait begins",
    "Serial work model · two requests arrive together · constructed work units",
    `${ticks}${row("REQUEST A / SLOT 1", 170, 0, 4, 8)}${row("REQUEST B / SLOT 1", 245, 12, 4, 8)}${text(60, 327, "WORK UNITS →", 11)}`,
  );
}

function goRequest() {
  const names = [
    ["01", "PARSE", "Read request input"],
    ["02", "VALIDATE", "Check the contract"],
    ["03", "HANDLER", "Run bounded work"],
    ["04", "REPLY", "Return a result"],
  ];
  const xs = [52, 340, 628, 916];
  let body = names
    .map(
      ([number, label, detail], index) =>
        `${box(xs[index], 162, 224, 82, index === 1 ? colors.mint : "#33455c")}${text(xs[index] + 18, 185, number, 11, colors.blue)}${text(xs[index] + 18, 209, label, 19, colors.ink)}${text(xs[index] + 18, 230, detail, 11)}`,
    )
    .join("");
  for (let i = 0; i < 3; i++)
    body += path(`M${xs[i] + 225} 203H${xs[i + 1] - 13}`);
  body += `${path("M452 245V282H702", colors.red)}${box(715, 263, 425, 54, colors.red, "#261d26")}${text(735, 286, "INVALID INPUT → RETURN EARLY", 13, colors.red)}${text(735, 305, "Handler work is skipped; keep failure explicit.", 11)}${text(52, 312, "A REQUEST IS A CONTROL FLOW,", 11)}${text(52, 332, "NOT JUST A SUCCESSFUL FUNCTION CALL.", 11)}`;
  return frame(
    "02 / GO REQUEST PATH",
    "Follow the request, not just the code",
    "Illustrative application flow · validate before work · preserve a clear failure branch",
    body,
  );
}

function network() {
  const xs = [90, 470, 850];
  const stages = [
    ["01 / NAME", "Resolve an address"],
    ["02 / PORT", "Connect to a listener"],
    ["03 / HTTP", "Inspect the response"],
  ];
  let body = stages
    .map(
      ([title, detail], index) =>
        `${box(xs[index], 161, 260, 86, index === 1 ? colors.blue : "#33455c")}${text(xs[index] + 20, 193, title, 20, index === 1 ? colors.blue : colors.ink)}${text(xs[index] + 20, 225, detail, 13)}`,
    )
    .join("");
  body += path("M351 204H455") + path("M731 204H835");
  body += `${path("M600 248V284", colors.red)}${box(360, 294, 480, 43, colors.red, "#261d26")}${text(600, 321, "CONNECTION REFUSED → CHECK THE LISTENER", 12, colors.red, "middle")}`;
  return frame(
    "03 / NETWORK DIAGNOSIS",
    "Find the layer before changing the system",
    "Illustrative failure location · no network request is performed by this diagram",
    body,
  );
}

await mkdir(output, { recursive: true });
await mkdir(originals, { recursive: true });
for (const [name, svg] of [
  ["inference", inference()],
  ["go-request", goRequest()],
  ["linux-network", network()],
]) {
  const image = await sharp(Buffer.from(svg))
    .png({ palette: true, compressionLevel: 9 })
    .toBuffer();
  const info = await sharp(image).metadata();
  if (info.width !== 1200 || info.height !== 400 || image.length >= 150 * 1024)
    throw new Error("Cover exceeded its dimensions or size budget.");
  await writeFile(new URL(`${name}.png`, output), image);
  await writeFile(new URL(`${name}.png`, originals), image);
  console.log(
    JSON.stringify({
      name,
      width: info.width,
      height: info.height,
      bytes: image.length,
    }),
  );
}
