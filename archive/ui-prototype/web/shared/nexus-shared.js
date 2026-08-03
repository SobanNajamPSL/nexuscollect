/* NexusCollect — shared formatting/i18n/status logic, reused across all six screens.
   Loaded as a plain global (not an ES module) so every screen can <script src="../shared/nexus-shared.js">
   in its <helmet> regardless of folder depth. */
(function () {
  var EN_ONES = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
    'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  var EN_TENS = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function enUnder100(n) {
    if (n < 20) return EN_ONES[n];
    var t = Math.floor(n / 10), o = n % 10;
    return EN_TENS[t] + (o ? ' ' + EN_ONES[o] : '');
  }

  var UR_ONES = ["صفر","ایک","دو","تین","چار","پانچ","چھ","سات","آٹھ","نو","دس",
    "گیارہ","بارہ","تیرہ","چودہ","پندرہ","سولہ","سترہ","اٹھارہ","انیس","بیس",
    "اکیس","بائیس","تیئس","چوبیس","پچیس","چھبیس","ستائیس","اٹھائیس","انتیس","تیس",
    "اکتیس","بتیس","تینتیس","چونتیس","پینتیس","چھتیس","سینتیس","اڑتیس","انتالیس","چالیس",
    "اکتالیس","بیالیس","تینتالیس","چوالیس","پینتالیس","چھیالیس","سینتالیس","اڑتالیس","انچالیس","پچاس",
    "اکاون","باون","ترپن","چون","پچپن","چھپن","ستاون","اٹھاون","انسٹھ","ساٹھ",
    "اکسٹھ","باسٹھ","تریسٹھ","چونسٹھ","پینسٹھ","چھیاسٹھ","سڑسٹھ","اڑسٹھ","انہتر","ستر",
    "اکہتر","بہتر","تہتر","چوہتر","پچہتر","چھہتر","ستتر","اٹھہتر","اناسی","اسی",
    "اکاسی","بیاسی","تراسی","چوراسی","پچاسی","چھیاسی","ستاسی","اٹھاسی","نواسی","نوے",
    "اکانوے","بانوے","ترانوے","چورانوے","پچانوے","چھیانوے","ستانوے","اٹھانوے","ننانوے"];

  function splitGroups(n) {
    var crore = Math.floor(n / 1e7); n %= 1e7;
    var lakh = Math.floor(n / 1e5); n %= 1e5;
    var thousand = Math.floor(n / 1e3); n %= 1e3;
    var hundred = Math.floor(n / 100); n %= 100;
    return { crore: crore, lakh: lakh, thousand: thousand, hundred: hundred, rest: n };
  }

  function amountInWordsEN(minor) {
    minor = Math.round(Number(minor) || 0);
    var neg = minor < 0; minor = Math.abs(minor);
    var rupees = Math.floor(minor / 100), paisa = minor % 100;
    var g = splitGroups(rupees), parts = [];
    if (g.crore) parts.push(enUnder100(g.crore) + ' Crore');
    if (g.lakh) parts.push(enUnder100(g.lakh) + ' Lakh');
    if (g.thousand) parts.push(enUnder100(g.thousand) + ' Thousand');
    if (g.hundred) parts.push(EN_ONES[g.hundred] + ' Hundred');
    if (g.rest) parts.push(enUnder100(g.rest));
    var words = parts.length ? parts.join(' ') : 'Zero';
    var result = 'Rupees ' + words;
    if (paisa) result += ' and ' + enUnder100(paisa) + ' Paisa';
    result += ' Only';
    return (neg ? 'Minus ' : '') + result;
  }

  function amountInWordsUR(minor) {
    minor = Math.round(Number(minor) || 0);
    var rupees = Math.floor(Math.abs(minor) / 100), paisa = Math.abs(minor) % 100;
    var g = splitGroups(rupees), parts = [];
    if (g.crore) parts.push(UR_ONES[g.crore] + ' کروڑ');
    if (g.lakh) parts.push(UR_ONES[g.lakh] + ' لاکھ');
    if (g.thousand) parts.push(UR_ONES[g.thousand] + ' ہزار');
    if (g.hundred) parts.push(UR_ONES[g.hundred] + ' سو');
    if (g.rest) parts.push(UR_ONES[g.rest]);
    var words = parts.length ? parts.join(' ') : UR_ONES[0];
    var result = words + ' روپے';
    if (paisa) result += ' اور ' + UR_ONES[paisa] + ' پیسے';
    result += ' صرف';
    return result;
  }

  function groupInt(n) {
    var s = String(Math.trunc(Math.abs(n)));
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatAmount(minor) {
    minor = Math.round(Number(minor) || 0);
    var neg = minor < 0;
    var abs = Math.abs(minor);
    var whole = Math.floor(abs / 100), frac = abs % 100;
    return (neg ? '-' : '') + groupInt(whole) + '.' + String(frac).padStart(2, '0');
  }

  function formatPKR(minor) {
    return 'PKR ' + formatAmount(minor);
  }

  var EN_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var UR_MONTHS = ['جنوری','فروری','مارچ','اپریل','مئی','جون','جولائی','اگست','ستمبر','اکتوبر','نومبر','دسمبر'];

  function formatDate(iso, lang) {
    if (!iso) return '';
    var d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
    if (isNaN(d.getTime())) return iso;
    var day = d.getDate(), mo = d.getMonth(), yr = d.getFullYear();
    if (lang === 'ur') return day + ' ' + UR_MONTHS[mo] + ' ' + yr;
    return day + ' ' + EN_MONTHS[mo] + ' ' + yr;
  }

  function formatDateTime(iso, lang) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var datePart = formatDate(iso.slice(0, 10), lang);
    var hh = d.getHours(), mm = String(d.getMinutes()).padStart(2, '0');
    var ampm = hh >= 12 ? 'PM' : 'AM';
    var h12 = hh % 12 || 12;
    return datePart + ', ' + h12 + ':' + mm + ' ' + ampm;
  }

  function maskName(name) {
    if (!name) return '';
    var head = name.slice(0, 2);
    var rest = Math.min(Math.max(name.length - 2, 0), 10);
    return head + Array(rest + 1).join('*');
  }

  function dirFor(lang) { return lang === 'ur' ? 'rtl' : 'ltr'; }
  function fontFamilyFor(lang) {
    return lang === 'ur'
      ? "'Noto Nastaliq Urdu','Noto Sans Urdu',var(--font-body)"
      : 'var(--font-body)';
  }

  // tone: neutral | brand | success | warning | danger | info  (Badge tones)
  var STATUS_META = {
    OVERDUE: { tone: 'danger', label: 'Overdue' },
    ISSUED: { tone: 'info', label: 'Issued' },
    SETTLED: { tone: 'success', label: 'Settled' },
    PARTIALLY_PAID: { tone: 'warning', label: 'Partially Paid' },
    ALREADY_SETTLED: { tone: 'success', label: 'Already Settled' },
    UNCERTAIN: { tone: 'info', label: 'Confirming Payment' },
    PROVISIONAL: { tone: 'warning', label: 'Provisional' },
    VALID: { tone: 'success', label: 'Valid' },
    VOIDED: { tone: 'neutral', label: 'Voided' },
    REFUNDED: { tone: 'info', label: 'Refunded' },
    CLEARED: { tone: 'success', label: 'Cleared' },
    RETURNED: { tone: 'danger', label: 'Returned' },
    HELD_POST_DATED: { tone: 'neutral', label: 'Held — Post-Dated' },
    IN_CLEARING: { tone: 'info', label: 'In Clearing' },
    LODGED: { tone: 'neutral', label: 'Lodged' },
    OPEN: { tone: 'warning', label: 'Open' },
    RESOLVED: { tone: 'success', label: 'Resolved' },
    AUTO_RESOLVED: { tone: 'success', label: 'Auto-Resolved' },
    PROPOSED: { tone: 'info', label: 'Proposed' },
    PENDING_APPROVAL: { tone: 'info', label: 'Pending Approval' },
    REJECTED: { tone: 'danger', label: 'Rejected' },
    PASS: { tone: 'success', label: 'Pass' },
    FAIL: { tone: 'danger', label: 'Fail' },
    CLASSIFICATION: { tone: 'neutral', label: 'Classification Issue' },
    NOT_FOUND: { tone: 'neutral', label: 'Not Found' },
    INVALID: { tone: 'danger', label: 'Invalid Reference' }
  };

  window.NexusShared = {
    formatPKR: formatPKR,
    formatAmount: formatAmount,
    amountInWordsEN: amountInWordsEN,
    amountInWordsUR: amountInWordsUR,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    dirFor: dirFor,
    fontFamilyFor: fontFamilyFor,
    STATUS_META: STATUS_META
  };
})();
