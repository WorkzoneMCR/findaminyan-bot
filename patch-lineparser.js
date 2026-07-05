const fs = require('fs');
const path = 'financial-hub.html';
// Normalize ALL CRLF → LF so replacements work consistently
let h = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

// ─── PATCH 1: Replace lineRe regex approach in parseInvoiceText with line-by-line ───
const OLD1 = `  // ── Blackbird-style line items ───────────────────────────────────────────
  // Each line: "Category  ...desc...  DD/MM/YY–DD/MM/YY  net  vat  gross"
  // The date range uses either an en-dash (\\u2013) or regular hyphen
  const lineRe = new RegExp(
    '(Broadband(?:\\\\s+Rental)?|Install(?:ation)?|Engineer\\\\s+Visit|Aborted(?:\\\\s+Visit)?|Missed\\\\s+Appointment'
    + '|Call(?:s|ing)?(?:\\\\s+(?:Charge|Usage|Cost))?|Extension|DDI|SIP(?:\\\\s+Line)?|IP\\\\s+Phone|Handset(?:\\\\s+Rental)?'
    + '|Adaptor|Adapter|Router(?:\\\\s+Rental)?|Hub(?:\\\\s+Rental)?)'
    + '([\\\\s\\\\S]*?)'
    + '(\\\\d{2}[\\\\/-]\\\\d{2}[\\\\/-]\\\\d{2,4}[\\\\s\\\\u2013\\\\-]+\\\\d{2}[\\\\/-]\\\\d{2}[\\\\/-]\\\\d{2,4})'
    + '\\\\s+([\\\\d,]+\\\\.\\\\d{2})\\\\s+([\\\\d,]+\\\\.\\\\d{2})\\\\s+([\\\\d,]+\\\\.\\\\d{2})',
    'gi'
  );
  let m;
  while ((m = lineRe.exec(text)) !== null) {
    const cat    = m[1].toLowerCase().replace(/\\s+/g,' ');
    const desc   = m[2]||'';
    const net    = parseFloat(m[4].replace(/,/g,''));
    const vat    = parseFloat(m[5].replace(/,/g,''));
    const gross  = parseFloat(m[6].replace(/,/g,''));
    const period = m[3]||'';
    if (isNaN(net) || net < 0 || net > 99999) continue;
    const refM = desc.match(/\\bref\\s+([A-Z0-9][A-Z0-9\\-]+)/i);
    const ref  = refM ? refM[1].trim() : '';
    result.lineItems.push({ ref, category:m[1], description:desc.trim().replace(/\\s+/g,' ').slice(0,120), net, vat, gross, period });
    if      (/broadband|fttp|sogea|fibre|fbb|internet|rental/.test(cat)) result.broadband  += net;
    else if (/install/.test(cat))                                         result.other      += net;
    else if (/aborted|engineer|missed/.test(cat))                        result.aboredVisit += net;
    else if (/call/.test(cat))                                           result.calls      += net;
    else if (/extension|ddi|sip/.test(cat))                             result.extensions += net;
    else if (/ip.?phone|handset/.test(cat))                             result.ipPhone    += net;
    else if (/adaptor|adapter/.test(cat))                                result.adaptor    += net;
    else if (/router|hub/.test(cat))                                     result.router     += net;
    else                                                                  result.other      += net;
  }`;

const NEW1 = `  // ── Blackbird-style line items (line-by-line approach) ─────────────────────
  // PDF layout: amounts + period on one Y-grouped line; ref DT-xxx is on the NEXT line(s)
  // We scan for lines ending with "net vat gross", then look forward for the customer ref.
  {
    const textLines   = text.split('\\n');
    const amtLineRe   = /(\\d[\\d,]*\\.\\d{2})\\s+(\\d[\\d,]*\\.\\d{2})\\s+(\\d[\\d,]*\\.\\d{2})\\s*$/;
    const periodLineRe= /(\\d{2}[\\/]\\d{2}[\\/]\\d{2,4})\\s*[\\u2013\\u2014\\-]+\\s*(\\d{2}[\\/]\\d{2}[\\/]\\d{2,4})/;
    const itemRefRe   = /\\bref\\s+([A-Z]{2,4}-[A-Z0-9][A-Z0-9\\-]*)/i;  // DT-222, WZ-5, FB-135A — NOT supplier ref ZWxxx
    const catWordRe   = /\\b(Broadband|Install(?:ation)?|Call(?:\\s+Charge)?|Extension|Router|IP\\s*Phone|Handset|Adaptor|Adapter|Hub|Engineer|Aborted|DDI|SIP)\\b/i;

    for (let _i = 0; _i < textLines.length; _i++) {
      const _line = textLines[_i];
      const _am   = _line.match(amtLineRe);
      if (!_am) continue;

      const net   = parseFloat(_am[1].replace(/,/g,''));
      const vat   = parseFloat(_am[2].replace(/,/g,''));
      const gross = parseFloat(_am[3].replace(/,/g,''));
      if (isNaN(net) || net < 0 || net > 99999) continue;

      // Period on this line
      const _pm2  = _line.match(periodLineRe);
      const period = _pm2 ? _pm2[0] : '';

      // Category: on this line, or the line above
      const _cm  = _line.match(catWordRe) || (_i > 0 ? textLines[_i-1].match(catWordRe) : null);
      const catStr = _cm ? _cm[0].trim() : 'Other';
      const cat    = catStr.toLowerCase().replace(/\\s+/g,' ');

      // Look forward 6 lines (joined) for the customer ref — stops at next amount line
      const _wparts = [];
      for (let _j = _i+1; _j < Math.min(_i+7, textLines.length); _j++) {
        if (textLines[_j].match(amtLineRe)) break;
        _wparts.push(textLines[_j]);
      }
      const _win = _wparts.join(' ');
      const _rm  = _win.match(itemRefRe);
      const ref  = _rm ? _rm[1] : '';

      result.lineItems.push({ ref, category:catStr, description:_win.trim().slice(0,120), net, vat, gross, period });
      if      (/broadband|fttp|sogea|fibre|fbb|internet|rental/.test(cat)) result.broadband  += net;
      else if (/install/.test(cat))                                          result.other      += net;
      else if (/aborted|engineer|missed/.test(cat))                         result.aboredVisit += net;
      else if (/call/.test(cat))                                            result.calls      += net;
      else if (/extension|ddi|sip/.test(cat))                              result.extensions += net;
      else if (/ip.?phone|handset/.test(cat))                              result.ipPhone    += net;
      else if (/adaptor|adapter/.test(cat))                                 result.adaptor    += net;
      else if (/router|hub/.test(cat))                                      result.router     += net;
      else                                                                   result.other      += net;
    }
  }`;

// ─── PATCH 2: refdItems should only include items with net > 0 ───────────────
const OLD2 = `    const refdItems = (parsed.lineItems||[]).filter(li => li.ref);`;
const NEW2 = `    const refdItems = (parsed.lineItems||[]).filter(li => li.ref && li.net > 0);`;

// Apply patches
let changed = 0;

const old1Norm = OLD1.replace(/\r\n/g, '\n');
const old2Norm = OLD2.replace(/\r\n/g, '\n');

if (h.includes(old1Norm)) {
  h = h.replace(old1Norm, NEW1);
  console.log('PATCH 1: lineRe → line-by-line parser ✓');
  changed++;
} else {
  console.error('PATCH 1 FAILED: old string not found');
  console.log('Looking for comment:', h.includes('  // ── Blackbird-style line items ───'));
}

if (h.includes(old2Norm)) {
  h = h.replace(old2Norm, NEW2);
  console.log('PATCH 2: refdItems filter net > 0 ✓');
  changed++;
} else {
  console.error('PATCH 2 FAILED: old string not found');
}

if (changed > 0) {
  fs.writeFileSync(path, h, 'utf8');
  console.log('\nAll', changed, 'patches applied and saved.');
  // Quick JS validation
  const jsStart = h.indexOf('<script>');
  const jsEnd   = h.lastIndexOf('</script>');
  if (jsStart > 0 && jsEnd > 0) {
    try {
      new Function(h.slice(jsStart+8, jsEnd));
      console.log('JS syntax: valid ✓');
    } catch(e) {
      console.error('JS syntax ERROR:', e.message);
    }
  }
} else {
  console.error('No patches applied.');
}
