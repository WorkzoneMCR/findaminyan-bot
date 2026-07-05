const fs = require('fs');
const p = 'financial-hub.html';
let h = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let ok = 0;

function patch(name, old, nw) {
  if (h.includes(old)) { h = h.replace(old, nw); console.log(name, '✓'); ok++; }
  else console.error(name, 'FAILED — old string not found');
}

// ─── 1. CRM importCRMDirect: add supplierRef, improve socketType + broadbandPackage ────────
patch('CRM-socketType+supplierRef',
`      socketType:       col('Socket Type'),
      hw1Type:          col('Hardware'),`,
`      socketType:       col('Socket Type') || (() => { const bp=(col('Beeline Product','Beeline Order Type')||'').toUpperCase(); return bp.startsWith('FTTP')?'FTTP':bp.startsWith('SOGEA')?'SOGEA':bp.startsWith('SOTAP')?'SOTAP':''; })(),
      supplierRef:      col('Beeline Order Ref','Supplier Ref','supplier_ref'),
      hw1Type:          col('Hardware'),`
);

patch('CRM-broadbandPackage',
`      broadbandPackage: col('FBB Package','Broadband Package'),`,
`      broadbandPackage: col('FBB Package','Broadband Package') || formatBBProduct(col('Beeline Product','Beeline Order Type')),`
);

// ─── 2. buildTx Stripe: extract Card Address fields ─────────────────────────────────────
patch('buildTx-Stripe-address',
`    ref         = row.id||row.ID||row['Payment ID']||row.charge_id||row['Balance Transaction ID']||'';
    // Type: refunded row has Amount Refunded > 0
    const refundedAmt = parseFloat(String(row['Amount Refunded']||'0').replace(/[,\\s]/g,''))||0;
    type = refundedAmt > 0 ? 'refund' : 'charge';
    return { id:uid(), src, source:src, type, amount, fee:txFee, net:txNet,
      date:normalizeDate(date), description:String(description).slice(0,220),
      custEmail, custName, customerEmail:custEmail, customerName:custName,
      customerId:null, matched:false, matchConfidence:0, matchedAt:null, matchNotes:'',
      ref:String(ref).slice(0,80), importedAt:new Date().toISOString() };`,
`    ref         = row.id||row.ID||row['Payment ID']||row.charge_id||row['Balance Transaction ID']||'';
    // Type: refunded row has Amount Refunded > 0
    const refundedAmt = parseFloat(String(row['Amount Refunded']||'0').replace(/[,\\s]/g,''))||0;
    type = refundedAmt > 0 ? 'refund' : 'charge';
    // Address fields (unified_payments export: Card Address Line1 / Card Address Zip)
    const cardAddress = (row['Card Address Line1']||row['card_address_line1']||'').trim();
    const cardZip     = (row['Card Address Zip']||row['Card Zip']||row['card_address_zip']||'').trim().toUpperCase().replace(/\\s/g,'');
    return { id:uid(), src, source:src, type, amount, fee:txFee, net:txNet,
      date:normalizeDate(date), description:String(description).slice(0,220),
      custEmail, custName, customerEmail:custEmail, customerName:custName,
      cardAddress, cardZip,
      customerId:null, matched:false, matchConfidence:0, matchedAt:null, matchNotes:'',
      ref:String(ref).slice(0,80), importedAt:new Date().toISOString() };`
);

// ─── 3. MAPPING_FIELDS.stripe: add cardAddress, cardZip; make sellerMessage optional ───
patch('MAPPING_FIELDS-stripe',
`  stripe:  [{key:'date',label:'Date',r:1},{key:'amount',label:'Gross Amount',r:1},{key:'fee',label:'Stripe Fee'},{key:'sellerMessage',label:'Seller Message (FILTER — only "Payment complete." rows are imported)',r:1},{key:'customerEmail',label:'Customer Email'},{key:'customerName',label:'Customer Name'},{key:'description',label:'Description'},{key:'ref',label:'Charge / Transaction ID'}],`,
`  stripe:  [{key:'date',label:'Date',r:1},{key:'amount',label:'Gross Amount',r:1},{key:'fee',label:'Stripe Fee'},{key:'sellerMessage',label:'Seller Message (FILTER)'},{key:'customerEmail',label:'Customer Email'},{key:'customerName',label:'Customer Name'},{key:'cardAddress',label:'Card Address Line 1 (address matching)'},{key:'cardZip',label:'Card Postcode / Zip (address matching)'},{key:'description',label:'Description'},{key:'ref',label:'Charge / Transaction ID'}],`
);

// ─── 4. FIELD_SYNONYMS: add cardAddress, cardZip entries ────────────────────────────────
patch('FIELD_SYNONYMS-cardAddress+Zip',
`  status:        ['status','payment_status','charge_status','transaction_status','state','outcome'],`,
`  status:        ['status','payment_status','charge_status','transaction_status','state','outcome'],
  cardAddress:   ['card_address_line1','card_address_line','card_address','address_line1','billing_address_line1','card_street','card_address_line_1'],
  cardZip:       ['card_address_zip','card_zip','postal_code','postcode','card_postcode','billing_zip','card_postal_code'],`
);

// ─── 5. autoMatchTransactions: add address matching before name/email ────────────────────
patch('autoMatchTx-address',
`  txs.forEach(tx => {
    if (tx.matched) return;
    let best=null, bestScore=0;
    custs.forEach(c => {
      // Use bulkSimilarity for rich token/initial/surname matching
      const score = bulkSimilarity(tx, c);
      if (score>bestScore && score>=62) { bestScore=score; best=c; }
    });
    if (best) {`,
`  txs.forEach(tx => {
    if (tx.matched) return;
    let best=null, bestScore=0;
    // Priority 1: address matching (unified_payments CSV — Card Address Line1 + Zip)
    if (tx.cardAddress || tx.cardZip) {
      const normA = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,' ').replace(/\\s+/g,' ').trim();
      const normZ = s => (s||'').toUpperCase().replace(/\\s/g,'');
      const txA = normA(tx.cardAddress); const txZ = normZ(tx.cardZip);
      const txTok = txA.split(' ').filter(t => t.length > 0);
      custs.forEach(c => {
        const cA = normA(c.address||c.serviceAddress||''); const cZ = normZ(c.postcode||'');
        let sc = 0;
        if (txZ && cZ && txZ === cZ) sc += 55;
        if (txA && cA && txTok.length) {
          const cTok = cA.split(' ').filter(t => t.length > 0);
          const common = txTok.filter(t => cTok.includes(t));
          sc += Math.round((common.length / Math.max(txTok.length, 1)) * 45);
        }
        if (sc >= 75 && sc > bestScore) { bestScore = sc; best = c; }
      });
    }
    // Priority 2: name/email similarity (bulkSimilarity)
    if (!best) custs.forEach(c => {
      // Use bulkSimilarity for rich token/initial/surname matching
      const score = bulkSimilarity(tx, c);
      if (score>bestScore && score>=62) { bestScore=score; best=c; }
    });
    if (best) {`
);

// ─── 6. processTxRowsWithMap: add address matching before email ───────────────────────────
patch('processTxRowsWithMap-address',
`    const custEmail = g('customerEmail').toLowerCase();
    const custName  = g('customerName');
    let customerId=null, matchConf=0;
    if (custEmail) { const m=custs.find(c=>c.email===custEmail); if(m){customerId=m.id;matchConf=95;} }
    if (!customerId&&custName) {
      let best=null,bs=0;
      custs.forEach(c=>{const s=similarity(c.name,custName)*100;if(s>bs&&s>=62){bs=s;best=c;}});
      if(best){customerId=best.id;matchConf=Math.round(bs);}
    }`,
`    const custEmail   = g('customerEmail').toLowerCase();
    const custName    = g('customerName');
    const txCardAddr  = mapping.cardAddress ? g('cardAddress').trim() : '';
    const txCardZip   = (mapping.cardZip ? g('cardZip') : '').trim().toUpperCase().replace(/\\s/g,'');
    let customerId=null, matchConf=0;
    // Priority 1: address matching (unified_payments CSV)
    if (txCardAddr || txCardZip) {
      const normA = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,' ').replace(/\\s+/g,' ').trim();
      const txA   = normA(txCardAddr); const txZ = txCardZip;
      const txTok = txA.split(' ').filter(t => t.length > 0);
      let best=null,bs=0;
      custs.forEach(c => {
        const cA=normA(c.address||c.serviceAddress||''); const cZ=(c.postcode||'').toUpperCase().replace(/\\s/g,'');
        let sc=0;
        if (txZ && cZ && txZ===cZ) sc+=55;
        if (txA && cA && txTok.length) { const cTok=cA.split(' ').filter(t=>t.length>0); const cm=txTok.filter(t=>cTok.includes(t)); sc+=Math.round((cm.length/Math.max(txTok.length,1))*45); }
        if (sc>=75 && sc>bs) { bs=sc; best=c; }
      });
      if (best) { customerId=best.id; matchConf=bs; }
    }
    // Priority 2: email exact match
    if (!customerId && custEmail) { const m=custs.find(c=>c.email===custEmail); if(m){customerId=m.id;matchConf=95;} }
    // Priority 3: name similarity
    if (!customerId&&custName) {
      let best=null,bs=0;
      custs.forEach(c=>{const s=similarity(c.name,custName)*100;if(s>bs&&s>=62){bs=s;best=c;}});
      if(best){customerId=best.id;matchConf=Math.round(bs);}
    }`
);

// Write + validate
if (ok > 0) {
  fs.writeFileSync(p, h, 'utf8');
  console.log('\nSaved', ok, '/', 6, 'patches.');
  const js = h.slice(h.indexOf('<script>')+8, h.lastIndexOf('</script>'));
  try { new Function(js); console.log('JS syntax: valid ✓'); }
  catch(e) { console.error('JS syntax ERROR:', e.message); }
} else {
  console.error('Nothing saved.');
}
