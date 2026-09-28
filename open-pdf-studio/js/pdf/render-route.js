// Wie tekent de pagina: het Rust-pad (PDFium) of PDF.js?
//
// De bureaubladversie rastert elke pagina met PDFium. Dat pad heeft twee
// dingen nodig: de Tauri-brug én een bestandspad op schijf — PDFium leest het
// bestand zelf, het krijgt geen bytes aangereikt.
//
// In de webversie (open-pdf-studio.open-aec.com) bestaat geen van beide. Een
// bestand dat via de browser-bestandskiezer binnenkomt heeft alleen een NAAM;
// `doc.filePath` is daar dus wél gevuld, maar met "Contract.pdf" in plaats van
// een pad. Dat is precies waar issue #355 op stukliep: de terugval naar PDF.js
// stond op "géén bestandspad", en die voorwaarde was in de browser onwaar.
// Gevolg: het Rust-pad werd overgeslagen (geen Tauri) én de terugval ook, dus
// er tekende niemand. Het canvas bleef op 300x150 staan — de standaardmaat van
// een <canvas> waar nooit naartoe geschreven is — en dat is het "kleine witte
// vlak" uit de melding.
//
// De regel hoort dus te zijn: PDF.js tekent zodra het Rust-pad niet kán, om
// wélke van de twee redenen dan ook.

/**
 * Moet PDF.js deze pagina tekenen?
 *
 * @param {object} o
 * @param {boolean} o.inTauri            Draait de app in de Tauri-schil?
 * @param {boolean} o.hasFilePath        Heeft het document een pad op schijf?
 * @param {boolean} [o.isMobile]         Mobiele builds hebben geen gebundelde
 *   PDFium; gebruik daar de bytes die PDF.js al heeft.
 * @param {boolean} [o.viewportNamHetOver] Heeft het viewport-pad (vector of
 *   raster) de pagina al geclaimd? Dan tekent de RAF-lus en moet PDF.js
 *   afblijven — anders vechten twee tekenaars om hetzelfde canvas.
 * @returns {boolean}
 */
export function pdfjsFallbackNodig({ inTauri, hasFilePath, isMobile = false, viewportNamHetOver = false }) {
  if (viewportNamHetOver) return false;
  return isMobile || !inTauri || !hasFilePath;
}
