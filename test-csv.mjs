import { readFileSync } from 'fs';
const csv = readFileSync('C:/Users/Greenbaum/Downloads/DartTelecom_Customers_2026-07-02 (2).csv', 'utf8');

const lines = csv.split('\n');
const parseRow = line => {
  const r=[]; let cur='',inQ=false;
  for(const c of line){
    if(c==='"'){inQ=!inQ;}
    else if(c===','&&!inQ){r.push(cur.trim());cur='';}
    else cur+=c;
  }
  r.push(cur.trim()); return r;
};

const rawHeaders = parseRow(lines[0]);
console.log('BOM on first char:', rawHeaders[0].charCodeAt(0)===0xFEFF);
const headers = rawHeaders.map(h=>h.replace(/^\uFEFF/,'').replace(/^"|"$/g,'').trim());
console.log('Beeline Order Ref idx:', headers.indexOf('Beeline Order Ref'));
console.log('Phone Plan / Package idx:', headers.indexOf('Phone Plan / Package'));
console.log('Plan / Package idx:', headers.indexOf('Plan / Package'));
console.log('\nAll column names:');
headers.forEach((h,i)=>console.log(` [${i}]`, JSON.stringify(h)));

const row1raw = parseRow(lines[1]);
const row1 = Object.fromEntries(headers.map((h,i)=>[h,(row1raw[i]||'').trim()]));

// Replicate col() exactly as in the HTML
const col = (...names) => {
  for (const n of names) {
    const key = Object.keys(row1).find(k => k.replace(/^\uFEFF/,'').trim().toLowerCase() === n.trim().toLowerCase());
    if (key !== undefined && row1[key] !== undefined && String(row1[key]).trim() !== '') {
      return String(row1[key]).trim();
    }
  }
  return '';
};

console.log('\n--- col() on row 1 ---');
console.log('Full Name         :', col('Full Name'));
console.log('Beeline Order Ref :', col('Beeline Order Ref','Beeline Ref','Supplier Ref','supplier_ref'));
console.log('Phone Plan/Package:', col('Phone Plan / Package','Phone Plan','Plan / Package'));
console.log('Postcode          :', col('Postcode','Post Code','ZIP'));

