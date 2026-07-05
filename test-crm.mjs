import { readFileSync } from 'fs';

// Replicate the exact col() function from the HTML
const parseCSV = (content) => {
  const lines = content.split('\n');
  const parseRow = line => {
    const r=[]; let cur='', inQ=false;
    for(const c of line){ if(c==='"'){inQ=!inQ;}else if(c===','&&!inQ){r.push(cur.trim());cur='';}else cur+=c; }
    r.push(cur.trim()); return r;
  };
  const headers = parseRow(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(l => {
    const vals = parseRow(l);
    const obj = {};
    headers.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  });
};

const csv = readFileSync('C:/Users/Greenbaum/Downloads/DartTelecom_Customers_2026-07-02 (2).csv', 'utf8');
const rows = parseCSV(csv);

// Replicate col() exactly as in the HTML
const testRow = (row) => {
  const col = (...names) => {
    for (const n of names) {
      const key = Object.keys(row).find(k => k.replace(/^\uFEFF/,'').trim().toLowerCase() === n.trim().toLowerCase());
      if (key !== undefined && row[key] !== undefined && String(row[key]).trim() !== '') {
        return String(row[key]).trim();
      }
    }
    return '';
  };
  const name = col('Full Name','Name','Customer Name');
  const supplierRef = col('Beeline Order Ref','Beeline Ref','Supplier Ref','supplier_ref');
  const postcode = col('Postcode','Post Code','ZIP');
  const callingPlanRaw = col('Phone Plan / Package','Phone Plan','FBB Calling Plan','Calling Plan','Plan / Package');
  return { name, supplierRef, postcode, callingPlanRaw };
};

console.log('First 8 rows:');
rows.slice(0, 8).forEach((row, i) => {
  const r = testRow(row);
  console.log(`${i+1}. ${r.name} | supplierRef=${JSON.stringify(r.supplierRef)} | postcode=${JSON.stringify(r.postcode)} | plan=${JSON.stringify(r.callingPlanRaw)}`);
});

const withRef = rows.filter(r => testRow(r).supplierRef);
console.log(`\nRows with supplierRef: ${withRef.length} / ${rows.length}`);
