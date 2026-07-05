// test-parse.mjs — test the parseInvoiceText logic against the actual PDF
import { readFileSync } from 'fs';
import * as pdfjsLib from 'file:///C:/Users/Greenbaum/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'file:///C:/Users/Greenbaum/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs';

const buf = readFileSync('C:/Users/Greenbaum/Downloads/all invoices/BSL-00047.pdf');
const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), useWorkerFetch:false, isEvalSupported:false }).promise;

// Replicate the browser extraction (group by Y)
let fullText = '';
for (let p = 1; p <= pdf.numPages; p++) {
  const page = await pdf.getPage(p);
  const tc   = await page.getTextContent();
  const lineMap = {};
  tc.items.forEach(item => {
    if (!item.str.trim()) return;
    const y = Math.round(item.transform[5]);
    if (!lineMap[y]) lineMap[y] = [];
    lineMap[y].push({ x: item.transform[4], str: item.str });
  });
  Object.keys(lineMap).map(Number).sort((a,b) => b - a).forEach(y => {
    fullText += lineMap[y].sort((a,b) => a.x - b.x).map(i => i.str).join(' ') + '\n';
  });
  fullText += '\n';
}

// Replicate parseInvoiceText — LINE-BY-LINE approach
// Each "amount line" ends with net vat gross; ref is on the NEXT 1-3 lines
const lines = fullText.split('\n');
const amtRe    = /(\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})\s*$/;
const periodRe = /(\d{2}[\/]\d{2}[\/]\d{2,4})\s*[\u2013\u2014\-]+\s*(\d{2}[\/]\d{2}[\/]\d{2,4})/;
  const refRe    = /\bref\s+([A-Z]{2,4}-[A-Z0-9][A-Z0-9\-]*)/i;  // DT-222, WZ-5, FB-135A, BBO-2026-xxx — NOT supplier ref ZWxxx
const catRe    = /\b(Broadband|Install(?:ation)?|Call|Extension|Router|IP\s*Phone|Handset|Adaptor|Adapter|Hub|Engineer|Aborted|DDI|SIP)\b/i;

const lineItems = [];
let totalNet = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const amtM = line.match(amtRe);
  if (!amtM) continue;

  const net   = parseFloat(amtM[1].replace(/,/g,''));
  const vat   = parseFloat(amtM[2].replace(/,/g,''));
  const gross = parseFloat(amtM[3].replace(/,/g,''));

  // Find period on this line
  const periodM = line.match(periodRe);
  const period  = periodM ? periodM[0] : '';

  // Find category on this line or the previous line
  const catM  = line.match(catRe) || (i > 0 ? lines[i-1].match(catRe) : null);
  const cat   = catM ? catM[0].trim() : 'Other';

  // Build search context: current line + 6 forward lines
  const windowLines = [lines[i]]; // include current line to bridge "ref\nDT-xxx" splits
  for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
    if (lines[j].match(amtRe)) break;
    windowLines.push(lines[j]);
  }
  const windowText = windowLines.join(' ');
  // 1. "ref DT-xxx" pattern; 2. bare code fallback for split-line case
  const refM = windowText.match(refRe)
            || windowText.match(/\b([A-Z]{2,4}-[A-Z0-9][A-Z0-9\-]{0,8})\b/i);
  const ref = refM ? refM[1] : '';

  lineItems.push({ cat, ref, net, vat, gross, period });
  totalNet += net;
}

const nonZero = lineItems.filter(li => li.net > 0);
console.log('=== NON-ZERO ITEMS (' + nonZero.length + ' found) ===');
nonZero.slice(0,10).forEach((li, i) => {
  console.log('\n--- Item', i, '---');
  console.log('cat:', JSON.stringify(li.cat));
  console.log('ref:', JSON.stringify(li.ref));
  console.log('net:', li.net, 'period:', li.period.slice(0,25));
});
const noRef = nonZero.filter(li => !li.ref);
console.log('\n=== NON-ZERO ITEMS WITHOUT REF:', noRef.length, '===');
noRef.forEach(li => console.log('  cat:', li.cat, 'net:', li.net, 'period:', li.period.slice(0,25)));

// Check refs
const refs = [...new Set(lineItems.map(li => li.ref).filter(Boolean))];
console.log('\n=== UNIQUE REFS (' + refs.length + ') ===');
refs.slice(0,30).forEach(r => console.log(r));

console.log('\n=== TOTAL NET =', totalNet.toFixed(2));

// Show first 500 chars of extracted text to debug
console.log('\n=== FIRST 500 chars of extracted text ===');
console.log(fullText.slice(0, 500));
