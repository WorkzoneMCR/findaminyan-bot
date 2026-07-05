const fs = require('fs');
const path = 'financial-hub.html';
let h = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

// ─── PATCH 1: Add "Import Orders CSV" button to customers header ───────────
const OLD1 = `      <button class="btn btn-secondary" onclick="document.getElementById('import-cust-file').click()">&#x2B06; Import CRM CSV</button>
      <input type="file" id="import-cust-file" accept=".csv" style="display:none" onchange="handleUpload(this,'crm');this.value=''">
      <input type="file" id="import-hw-file" accept=".csv,.txt" style="display:none" onchange="importHardwareList(this)">
      <button class="btn btn-primary" onclick="openCustomerModal()">+ Add Customer</button>`;

const NEW1 = `      <button class="btn btn-secondary" onclick="document.getElementById('import-cust-file').click()">&#x2B06; Import CRM CSV</button>
      <input type="file" id="import-cust-file" accept=".csv" style="display:none" onchange="handleUpload(this,'crm');this.value=''">
      <input type="file" id="import-hw-file" accept=".csv,.txt" style="display:none" onchange="importHardwareList(this)">
      <button class="btn btn-secondary" onclick="document.getElementById('import-orders-file').click()">&#x1F4CB; Import Orders CSV</button>
      <input type="file" id="import-orders-file" accept=".csv" style="display:none" onchange="handleOrdersCsvUpload(this);this.value=''">
      <button class="btn btn-primary" onclick="openCustomerModal()">+ Add Customer</button>`;

// ─── PATCH 2: Add Orders Import Modal before invoice modal ─────────────────
const OLD2 = `<!-- ═══ INVOICE MODAL ═══ -->`;

const NEW2 = `<!-- ═══ ORDERS IMPORT MODAL ═══ -->
<div class="modal-overlay" id="modal-orders-import">
  <div class="modal" style="width:900px;max-width:97vw;">
    <div class="modal-header">
      <div class="modal-title">Import Broadband Orders — Set Supplier Refs</div>
      <button class="modal-close" onclick="closeModal('modal-orders-import')">✕</button>
    </div>
    <div class="modal-body" style="padding:0 20px 16px">
      <p id="orders-import-summary" style="margin:12px 0 10px;color:var(--text2);font-size:13px"></p>
      <div class="table-wrap" style="max-height:420px;overflow-y:auto">
        <table>
          <thead><tr>
            <th style="width:36px"><input type="checkbox" id="orders-chk-all" onchange="ordersToggleAll(this.checked)" title="Select all"></th>
            <th>Ref</th>
            <th>End User (CSV)</th>
            <th>Matched Customer</th>
            <th>Product</th>
            <th>Status</th>
          </tr></thead>
          <tbody id="tbody-orders-import"></tbody>
        </table>
      </div>
    </div>
    <div class="modal-footer" style="display:flex;gap:10px;justify-content:flex-end;padding:14px 20px;border-top:1px solid var(--border)">
      <button class="btn btn-secondary" onclick="closeModal('modal-orders-import')">Cancel</button>
      <button class="btn btn-primary" onclick="applyOrdersImport()">Apply <span id="orders-import-count">0</span> Updates</button>
    </div>
  </div>
</div>

<!-- ═══ INVOICE MODAL ═══ -->`;

// ─── PATCH 3: Add JS functions before closing </script> ────────────────────
const OLD3 = `</script>
</body>
</html>`;

const NEW3 = `
// ═══════════════════════════════════════════════════════════════════════════
// BROADBAND ORDERS CSV IMPORT
// Reads CustomerOrderReference (DT-xxx, WZ-xxx, BBO-2026-xxx) and auto-matches
// to existing customers by name, then sets supplierRef + socketType + package.
// ═══════════════════════════════════════════════════════════════════════════

let _ordersRows = [];

function handleOrdersCsvUpload(input) {
  const file = input.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete(res) { processOrdersCsv(res.data); },
    error(e)     { toast('Could not read orders CSV: ' + e.message, 'warn'); }
  });
}

function formatBBProduct(p) {
  p = (p || '').trim();
  const known = {
    'FTTP0505':'FTTP 0.5/0.5', 'FTTP8020':'FTTP 80/20', 'FTTP16030':'FTTP 160/30',
    'FTTP1000115':'FTTP 1000/115', 'FTTP40010':'FTTP 400/10',
    'SOGEA0505':'SOGEA 0.5/0.5', 'SOGEA8020':'SOGEA 80/20', 'SOGEA16030':'SOGEA 160/30',
    'SOTAP':'SOTAP'
  };
  const key = p.replace(/[\s\/]/g,'').toUpperCase();
  return known[key] || p;
}

function processOrdersCsv(rows) {
  const custs = DB.get('customers');
  _ordersRows = [];

  rows.forEach(row => {
    const ref    = (row.CustomerOrderReference || row['Customer Order Reference'] || '').trim();
    const name   = (row.EndUserName || row['End User Name'] || '').trim();
    const product= (row.Product || '').trim();
    const status = (row.OrderStatusTxt || row['OrderStatus'] || '').trim();
    const dn     = (row.DN || '').trim();
    const suppId = (row.SupplierServiceID || '').trim();
    if (!ref || !name) return;

    // Derive socket type from product code
    const pu = product.toUpperCase();
    const socketType = pu.startsWith('FTTP') || pu.includes('FTTP') ? 'FTTP'
                     : pu.startsWith('SOGEA')                        ? 'SOGEA'
                     : pu.startsWith('SOTAP')                        ? 'SOTAP' : '';

    // Match to existing customer: first by supplierRef, then by name similarity
    let bestCust = null, bestScore = 0;
    // Priority 1: existing supplierRef matches this ref exactly
    const byRef = custs.find(c => (c.supplierRef||'').trim().toUpperCase() === ref.toUpperCase());
    if (byRef) { bestCust = byRef; bestScore = 1.0; }

    if (!bestCust) {
      // Priority 2: name similarity
      custs.forEach(c => {
        const sc = similarity(c.name, name);
        if (sc > bestScore) { bestScore = sc; bestCust = c; }
      });
    }

    // Require score >= 0.5 for automatic match
    const matched = bestCust && bestScore >= 0.5;

    _ordersRows.push({
      ref, name, product: formatBBProduct(product), socketType, status, dn, suppId,
      custId:   matched ? bestCust.id   : null,
      custName: matched ? bestCust.name : null,
      score:    bestScore,
      include:  matched  // auto-check matched rows
    });
  });

  _ordersRows.sort((a, b) => (b.score - a.score));
  _renderOrdersModal();
  document.getElementById('modal-orders-import').classList.add('active');
}

function _renderOrdersModal() {
  const tbody = document.getElementById('tbody-orders-import');
  const total = _ordersRows.filter(r => r.include).length;
  document.getElementById('orders-import-count').textContent = total;
  const matched  = _ordersRows.filter(r => r.custId).length;
  const total_rows = _ordersRows.length;
  document.getElementById('orders-import-summary').innerHTML =
    '<strong>' + total_rows + '</strong> orders found &mdash; '
    + '<strong style="color:var(--success)">' + matched + '</strong> matched to existing customers, '
    + '<strong style="color:var(--warning)">' + (total_rows - matched) + '</strong> unmatched (unchecked)';

  const statusBadge = s => {
    const cls = { Completed:'green', Committed:'blue', Delayed:'yellow', Cancelled:'red',
                  Active:'green', active:'green' }[s] || 'gray';
    return '<span class="badge badge-' + cls + '">' + (s||'—') + '</span>';
  };

  tbody.innerHTML = _ordersRows.map((r, i) => {
    const matchCell = r.custId
      ? '<span style="color:var(--success)">' + r.custName + '</span>'
        + (r.score < 1 ? ' <small style="color:var(--text2)">(' + Math.round(r.score*100) + '%)</small>' : '')
      : '<span style="color:var(--warning)">No match</span>';
    return '<tr style="' + (r.custId ? '' : 'opacity:0.6') + '">'
      + '<td><input type="checkbox" ' + (r.include?'checked':'') + ' onchange="_ordersRows[' + i + '].include=this.checked;document.getElementById(\'orders-import-count\').textContent=_ordersRows.filter(r=>r.include).length"></td>'
      + '<td><code style="font-size:12px">' + r.ref + '</code></td>'
      + '<td>' + r.name + '</td>'
      + '<td>' + matchCell + '</td>'
      + '<td><small>' + (r.product||'—') + '</small></td>'
      + '<td>' + statusBadge(r.status) + '</td>'
      + '</tr>';
  }).join('');
}

function ordersToggleAll(checked) {
  _ordersRows.forEach((r, i) => { r.include = checked; });
  _renderOrdersModal();
}

function applyOrdersImport() {
  const custs = DB.get('customers');
  let updated = 0;
  _ordersRows.filter(r => r.include && r.custId).forEach(r => {
    const c = custs.find(x => x.id === r.custId);
    if (!c) return;
    c.supplierRef = r.ref;
    if (r.socketType && !c.socketType) c.socketType = r.socketType;
    if (r.product  && !c.broadbandPackage) c.broadbandPackage = r.product;
    updated++;
  });
  DB.set('customers', custs);
  closeModal('modal-orders-import');
  renderCustomers();
  toast(updated + ' customer' + (updated===1?'':'s') + ' updated with broadband order refs');
}

</script>
</body>
</html>`;

// Apply all patches
let ok = 0;

if (h.includes(OLD1)) { h = h.replace(OLD1, NEW1); console.log('PATCH 1: Import Orders button ✓'); ok++; }
else console.error('PATCH 1 FAILED');

if (h.includes(OLD2)) { h = h.replace(OLD2, NEW2); console.log('PATCH 2: Orders Import modal HTML ✓'); ok++; }
else console.error('PATCH 2 FAILED');

if (h.includes(OLD3)) { h = h.replace(OLD3, NEW3); console.log('PATCH 3: JS functions ✓'); ok++; }
else console.error('PATCH 3 FAILED');

if (ok > 0) {
  fs.writeFileSync(path, h, 'utf8');
  console.log('\nSaved', ok, 'patches.');
  const jsStart = h.indexOf('<script>');
  const jsEnd   = h.lastIndexOf('</script>');
  if (jsStart > 0 && jsEnd > 0) {
    try { new Function(h.slice(jsStart+8, jsEnd)); console.log('JS syntax: valid ✓'); }
    catch(e) { console.error('JS syntax ERROR:', e.message); }
  }
}
