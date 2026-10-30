'use strict';

/**
 * URL Safety Checker — shared analyzer (logistics edition).
 *
 * Pure functions only: no DOM access and no chrome.* calls, so the very same
 * code runs in the popup, in the content script and in the service worker
 * (via importScripts). Everything is exposed on globalThis.USC.
 *
 * Scoring: every finding adds points; 0–14 Safe, 15–44 Caution,
 * 45–69 Suspicious, 70–100 Dangerous. Findings carry a type:
 *   'd' danger, 'w' warning, 'i' information, 'ok' positive signal.
 */
globalThis.USC = globalThis.USC || (() => {
  const VERSION = '2.3.0';

  const DEFAULT_SETTINGS = Object.freeze({
    vtKey: '',
    gsbKey: '',
    hoverPreview: true,   // tooltip when the mouse rests on a link
    markLinks: true,      // outline + dot next to risky links on web pages
    activeFetch: false,   // fetch the link from this browser (visits it!)
    allowlist: '',        // your own company domains, one per line
    enforceMode: 'off',   // off | blacklist | whitelist (central web filtering)
    whitelist: '',        // whitelist-mode: only these domains may load
    blacklist: '',        // always-blocked domains
  });

  const VERDICTS = Object.freeze({
    SAFE:       Object.freeze({ label: 'Safe',       icon: '✅', color: '#22c55e' }),
    CAUTION:    Object.freeze({ label: 'Caution',    icon: '⚠️', color: '#f59e0b' }),
    SUSPICIOUS: Object.freeze({ label: 'Suspicious', icon: '🔶', color: '#f97316' }),
    DANGEROUS:  Object.freeze({ label: 'Dangerous',  icon: '🚨', color: '#ef4444' }),
    UNKNOWN:    Object.freeze({ label: 'Unknown',    icon: '❓', color: '#64748b' }),
  });

  const THRESHOLDS = Object.freeze({ DANGEROUS: 70, SUSPICIOUS: 45, CAUTION: 15 });
  const SEVERITY = Object.freeze({ UNKNOWN: -1, SAFE: 0, CAUTION: 1, SUSPICIOUS: 2, DANGEROUS: 3 });

  function verdictFor(score) {
    if (score >= THRESHOLDS.DANGEROUS) return 'DANGEROUS';
    if (score >= THRESHOLDS.SUSPICIOUS) return 'SUSPICIOUS';
    if (score >= THRESHOLDS.CAUTION) return 'CAUTION';
    return 'SAFE';
  }

  // ── Reference data ──────────────────────────────────────────────────────────

  /** Second-level public suffixes so "example.co.uk" → "example.co.uk", not "co.uk". */
  const MULTI_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'gov.uk', 'ac.uk', 'nhs.uk',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
    'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
    'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'gr.jp',
    'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
    'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'firm.in',
    'com.mx', 'gob.mx', 'org.mx', 'edu.mx',
    'com.tr', 'net.tr', 'org.tr', 'gov.tr',
    'co.za', 'org.za', 'net.za', 'gov.za',
    'com.sg', 'edu.sg', 'gov.sg', 'com.hk', 'org.hk', 'edu.hk',
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'com.tw', 'org.tw',
    'com.ar', 'com.co', 'com.pe', 'com.ve', 'com.ua', 'com.pl', 'co.kr', 'or.kr',
    'com.ng', 'com.ph', 'com.my', 'com.vn', 'com.eg', 'com.sa', 'co.il', 'org.il',
    'com.pk', 'com.bd', 'co.id', 'or.id', 'ac.id', 'co.th', 'in.th', 'or.th', 'ac.th', 'go.th',
    'com.uy', 'com.py', 'com.bo', 'com.ec', 'com.gt', 'com.do', 'com.pa', 'com.ni', 'com.sv',
    'com.hn', 'com.cu', 'com.pr', 'com.jm', 'com.tt', 'com.kz', 'com.uz', 'co.uz', 'com.ge',
    'com.az', 'com.by', 'com.kg', 'com.tj', 'com.tm', 'com.af', 'com.np', 'com.lk', 'com.mm',
    'com.kh', 'com.la', 'com.mn', 'com.bn', 'com.es', 'co.ke', 'or.ke', 'co.tz', 'co.ug',
    'com.gh', 'com.et', 'com.na', 'co.zw', 'co.bw', 'com.zm', 'com.mw', 'co.mz',
  ]);

  const SUSPICIOUS_TLDS = new Set([
    '.tk', '.ml', '.ga', '.cf', '.gq', '.xyz', '.top', '.click', '.download', '.zip', '.mov',
    '.review', '.country', '.kim', '.men', '.loan', '.win', '.date', '.faith', '.webcam',
    '.accountants', '.party', '.racing', '.stream', '.bid', '.trade', '.science', '.icu',
    '.cam', '.rest', '.buzz', '.monster', '.quest', '.sbs', '.cfd', '.surf', '.work', '.link',
    '.fit', '.gdn', '.cyou', '.lol', '.bond', '.boats', '.hair', '.beauty', '.makeup', '.skin',
    '.autos', '.motorcycles', '.yachts',
  ]);

  const SHORTENERS = new Set([
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'buff.ly', 'is.gd', 'rb.gy', 'cutt.ly',
    'tiny.cc', 'short.io', 'adf.ly', 'lnkd.in', 'tr.im', 'dlvr.it', 'ift.tt', 'wp.me',
    'rebrand.ly', 'bl.ink', 'shorturl.at', 't.ly', 's.id', 'snip.ly', 'soo.gd', 'clck.ru',
    'v.gd', 'qr.ae', 'u.to', 'x.co', 'bit.do', 'mcaf.ee', 'han.gl', 'urlz.fr', 'shorte.st',
    'ouo.io', 'tinyurl.one', 'shrtco.de', 'cli.re', 'fw.to',
  ]);

  /** Registrable domains where anyone can publish a page (not the platform's own site). */
  const PLATFORMS = new Set([
    'amazonaws.com', 'windows.net', 'azurewebsites.net', 'azurestaticapps.net', 'web.app',
    'firebaseapp.com', 'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev',
    'workers.dev', 'r2.dev', 'glitch.me', 'weebly.com', 'wixsite.com', 'godaddysites.com',
    '000webhostapp.com', 'repl.co', 'replit.app', 'herokuapp.com', 'onrender.com', 'surge.sh',
    'webflow.io', 'carrd.co', 'strikingly.com', 'mystrikingly.com', 'yolasite.com',
    'blogspot.com', 'wordpress.com', 'webnode.page', 'jimdosite.com', 'site123.me',
    'notion.site', 'canva.site', 'typeform.com', 'jotform.com', 'formstack.com',
    'cognitoforms.com', 'wufoo.com', 'duckdns.org', 'ngrok.io', 'ngrok-free.app', 'ngrok.app',
    'loca.lt', 'trycloudflare.com', 'ipfs.io', 'dweb.link', 'infinityfreeapp.com', 'rf.gd',
    'epizy.com', 'ddns.net', 'no-ip.org', 'hopto.org', 'sytes.net', 'zapto.org', 'myftp.biz',
    'servehttp.com', 'webcindario.com',
  ]);

  /** Specific hosts of otherwise-trusted companies that host user-published content. */
  const PLATFORM_HOSTS = [
    'sites.google.com', 'forms.gle', 'forms.office.com', 'storage.googleapis.com',
    'firebasestorage.googleapis.com', 'script.google.com', 'script.googleusercontent.com',
    'cdn.discordapp.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com',
  ];

  /** TLD-looking labels that should never appear inside a subdomain (paypal.com.evil.net). */
  const EMBEDDED_TLDS = new Set(['com', 'net', 'org', 'gov', 'edu', 'io', 'co', 'us', 'info', 'biz']);

  const DANGEROUS_EXT = new Set([
    '.exe', '.bat', '.cmd', '.vbs', '.vbe', '.jse', '.ps1', '.psm1', '.msi', '.msp', '.scr',
    '.jar', '.hta', '.pif', '.cpl', '.dll', '.reg', '.lnk', '.wsf', '.wsh', '.iso', '.img',
    '.vhd', '.vhdx', '.apk', '.dmg', '.com',
  ]);
  const ARCHIVE_EXT = new Set(['.zip', '.rar', '.7z', '.gz', '.tgz', '.tar', '.bz2', '.cab', '.ace', '.arj', '.z']);
  const RISKY_ATTACHMENT_EXT = new Set(['.html', '.htm', '.shtml', '.svg', '.one', '.pdf.exe', '.js']);

  /**
   * Brands that phishing campaigns against carriers, brokers and dispatch
   * offices imitate most often. `pattern` is tested against the lower-cased
   * host name (without "www."); `domains` are the official registrable
   * domains; `text` is used when a fetched login page mentions the brand.
   */
  const BRANDS = [
    // Load boards, carrier onboarding, compliance
    { name: 'DAT',                  pattern: /(^|[.-])dat(one|load|power|iq|freight|solutions)?([.-]|$)/, domains: ['dat.com'] },
    { name: 'Truckstop',            pattern: /truckstop/, domains: ['truckstop.com'] },
    { name: 'Highway',              pattern: /(^|[.-])highway([.-]|$)/, domains: ['highway.com'] },
    { name: 'RMIS',                 pattern: /(^|[.-])rmis(secure)?([.-]|$)/, domains: ['rmissecure.com', 'rmis.com'] },
    { name: 'MyCarrierPackets',     pattern: /mycarrierpacket/, domains: ['mycarrierpackets.com'] },
    { name: 'Carrier411',           pattern: /carrier411/, domains: ['carrier411.com'] },
    { name: 'Carrier Assure',       pattern: /carrierassure/, domains: ['carrierassure.com'] },
    { name: 'Amazon',               pattern: /amazon/, domains: ['amazon.com', 'amazon.ca', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.com.mx', 'amazon.jobs', 'aboutamazon.com', 'amazon.work'] },
    { name: 'Uber Freight',         pattern: /(^|[.-])uber([.-]|freight|$)/, domains: ['uber.com', 'uberfreight.com'] },
    { name: 'J.B. Hunt',            pattern: /jbhunt/, domains: ['jbhunt.com'] },
    { name: 'C.H. Robinson',        pattern: /chrobinson|navisphere/, domains: ['chrobinson.com', 'navisphere.com'] },
    { name: 'TQL',                  pattern: /(^|[.-])tql([.-]|$)/, domains: ['tql.com'] },
    { name: 'Coyote Logistics',     pattern: /(^|[.-])coyote(logistics)?([.-]|$)/, domains: ['coyote.com'] },
    { name: 'Landstar',             pattern: /landstar/, domains: ['landstar.com', 'landstaronline.com'] },
    { name: 'XPO',                  pattern: /(^|[.-])xpo([.-]|$)/, domains: ['xpo.com'] },
    { name: 'Schneider',            pattern: /(^|[.-])schneider([.-]|$)/, domains: ['schneider.com', 'schneiderjobs.com', 'schneider-electric.com', 'se.com'] },
    { name: 'Werner',               pattern: /(^|[.-])werner([.-]|$)/, domains: ['werner.com'] },
    { name: 'Echo Global Logistics', pattern: /echoglobal|echo[.-]?logistics/, domains: ['echo.com'] },
    { name: 'Loadsmart',            pattern: /loadsmart/, domains: ['loadsmart.com'] },
    // Factoring, fuel cards, payments
    { name: 'TriumphPay',           pattern: /triumph[.-]?pay/, domains: ['triumphpay.com'] },
    { name: 'RTS Financial',        pattern: /(^|[.-])rts(financial|carrier|pro|inc)?([.-]|$)/, domains: ['rtsinc.com', 'rtsfinancial.com', 'rtspro.com'] },
    { name: 'OTR Solutions',        pattern: /otrsolutions|otr[.-]?capital/, domains: ['otrsolutions.com'] },
    { name: 'Apex Capital',         pattern: /apexcapital/, domains: ['apexcapital.com'] },
    { name: 'WEX / EFS',            text: /\b(WEX|EFS)\b/, pattern: /(^|[.-])(wex|efs|wexinc|efsllc)([.-]|$)/, domains: ['wexinc.com', 'efsllc.com', 'wexonline.com'] },
    { name: 'Comdata',              pattern: /comdata/, domains: ['comdata.com', 'icomdata.com'] },
    { name: 'Pilot Flying J',       pattern: /pilotflyingj|pilot[.-]?flying/, domains: ['pilotflyingj.com', 'pilotcompany.com'] },
    { name: "Love's",               text: /\bLove'?s\b/, pattern: /(^|[.-])loves([.-]|$)/, domains: ['loves.com'] },
    // Telematics / visibility
    { name: 'Samsara',              pattern: /samsara/, domains: ['samsara.com'] },
    { name: 'Motive (KeepTruckin)', text: /\b(Motive|KeepTruckin)\b/, pattern: /keeptruckin|gomotive|(^|[.-])motive([.-]|$)/, domains: ['gomotive.com', 'keeptruckin.com'] },
    { name: 'Omnitracs',            pattern: /omnitracs/, domains: ['omnitracs.com'] },
    { name: 'Trucker Path',         pattern: /truckerpath/, domains: ['truckerpath.com'] },
    { name: 'MacroPoint',           pattern: /macropoint/, domains: ['descartes.com', 'macropoint.com'] },
    { name: 'FourKites',            pattern: /fourkites/, domains: ['fourkites.com'] },
    { name: 'project44',            pattern: /project44/, domains: ['project44.com'] },
    // Parcel carriers
    { name: 'UPS',                  pattern: /(^|[.-])ups([.-]|$)/, domains: ['ups.com'] },
    { name: 'FedEx',                pattern: /fedex/, domains: ['fedex.com'] },
    { name: 'DHL',                  pattern: /(^|[.-])dhl([.-]|$)/, domains: ['dhl.com', 'dhl.de'] },
    { name: 'USPS',                 pattern: /(^|[.-])usps([.-]|$)/, domains: ['usps.com', 'usps.gov'] },
    // Office / documents — the most common lure for any business
    { name: 'Microsoft 365',        text: /\b(Microsoft|Office ?365|Outlook|SharePoint|OneDrive)\b/i, pattern: /microsoft|office365|office[.-]?365|outlook|sharepoint|onedrive|(^|[.-])o365([.-]|$)|microsoftonline/, domains: ['microsoft.com', 'microsoftonline.com', 'microsoftonline-p.com', 'office.com', 'office.net', 'office365.com', 'microsoft365.com', 'live.com', 'outlook.com', 'sharepoint.com', 'sharepointonline.com', 'onedrive.com', 'azure.com', 'msn.com', 'bing.com', 'skype.com', '1drv.ms', 'aka.ms', 'xbox.com', 'windows.com'] },
    { name: 'Google',               pattern: /google|gmail/, domains: ['google.com', 'gmail.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'youtube.com', 'withgoogle.com', 'google.dev', 'android.com', 'blog.google', 'googleblog.com', 'google.ca', 'google.co.uk'] },
    { name: 'Apple',                pattern: /(^|[.-])(apple|icloud|itunes)([.-]|$)/, domains: ['apple.com', 'icloud.com', 'itunes.com'] },
    { name: 'DocuSign',             pattern: /docusign/, domains: ['docusign.com', 'docusign.net'] },
    { name: 'Adobe',                pattern: /(^|[.-])(adobe|acrobat)([.-]|$)/, domains: ['adobe.com', 'acrobat.com', 'adobelogin.com', 'adobe.io'] },
    { name: 'Dropbox',              pattern: /dropbox/, domains: ['dropbox.com', 'dropboxusercontent.com'] },
    { name: 'Zoom',                 pattern: /(^|[.-])zoom([.-]|$)/, domains: ['zoom.us', 'zoom.com'] },
    // Money
    { name: 'PayPal',               pattern: /paypal/, domains: ['paypal.com', 'paypal.me'] },
    { name: 'QuickBooks / Intuit',  text: /\b(QuickBooks|Intuit)\b/i, pattern: /quickbooks|intuit/, domains: ['intuit.com', 'quickbooks.com'] },
    { name: 'Chase',                pattern: /(^|[.-])chase(bank|online)?([.-]|$)/, domains: ['chase.com', 'jpmorgan.com', 'jpmorganchase.com'] },
    { name: 'Bank of America',      pattern: /bankofamerica|(^|[.-])bofa([.-]|$)/, domains: ['bankofamerica.com', 'bofa.com'] },
    { name: 'Wells Fargo',          pattern: /wellsfargo/, domains: ['wellsfargo.com'] },
    { name: 'Citi',                 pattern: /(^|[.-])citi(bank)?([.-]|$)/, domains: ['citi.com', 'citibank.com'] },
    { name: 'Capital One',          pattern: /capitalone/, domains: ['capitalone.com'] },
    { name: 'U.S. Bank',            text: /\bU\.?S\.? ?Bank\b/i, pattern: /(^|[.-])usbank([.-]|$)/, domains: ['usbank.com'] },
    { name: 'PNC',                  pattern: /(^|[.-])pnc(bank)?([.-]|$)/, domains: ['pnc.com'] },
    { name: 'Truist',               pattern: /truist/, domains: ['truist.com'] },
    { name: 'Zelle',                pattern: /zelle/, domains: ['zellepay.com'] },
    { name: 'Venmo',                pattern: /venmo/, domains: ['venmo.com'] },
    { name: 'Coinbase',             pattern: /coinbase/, domains: ['coinbase.com'] },
    { name: 'Binance',              pattern: /binance/, domains: ['binance.com', 'binance.us'] },
    // Social (account-takeover lures)
    { name: 'Meta / Facebook',      text: /\b(Facebook|Instagram|WhatsApp)\b/i, pattern: /facebook|instagram|whatsapp/, domains: ['facebook.com', 'fb.com', 'instagram.com', 'whatsapp.com', 'meta.com', 'fbcdn.net'] },
    { name: 'LinkedIn',             pattern: /linkedin/, domains: ['linkedin.com'] },
    { name: 'Netflix',              pattern: /netflix/, domains: ['netflix.com'] },
    { name: 'eBay',                 pattern: /(^|[.-])ebay([.-]|$)/, domains: ['ebay.com'] },
  ];

  /** Brand names that are also ordinary words or surnames: "werner.de" may simply be another Werner. */
  const GENERIC_BRAND_NAMES = new Set(['Werner', 'Schneider', 'Coyote Logistics', 'Highway', 'Motive (KeepTruckin)', 'Zoom', 'Chase', 'Apple', 'Citi', "Love's", 'PNC', 'Truist']);

  for (const brand of BRANDS) {
    if (!brand.text) {
      const word = brand.name.split(/[\s/(]/)[0];
      const caseSensitive = word.length <= 4 && word === word.toUpperCase();
      brand.text = new RegExp('\\b' + escapeRegExp(word) + '\\b', caseSensitive ? '' : 'i');
    }
  }

  /** Well-known legitimate sites that are not brands we track for spoofing. */
  const TRUSTED_EXTRA = [
    'wikipedia.org', 'github.com', 'reddit.com', 'cloudflare.com', 'slack.com', 'salesforce.com',
    'hubspot.com', 'mailchimp.com', 'godaddy.com', 'squarespace.com', 'wix.com', 'shopify.com',
    'stripe.com', 'x.com', 'twitter.com', 'indeed.com', 'yahoo.com', 'aol.com', 'proton.me',
    'protonmail.com', 'bbb.org', 'ooida.com', 'trucking.org', 'freightwaves.com',
    'ccjdigital.com', 'overdriveonline.com', 'truckinginfo.com', 'thetrucker.com', 'nmfta.org',
    'smc3.com', 'jjkeller.com', 'penske.com', 'ryder.com', 'ta-petro.com', 'natso.com',
    'uship.com', 'freightquote.com', 'transcore.com', '123loadboard.com', 'directfreight.com',
  ];
  /** Freight brokers, carriers and 3PLs whose names scammers misspell (talgrassfreight ↔ tallgrassfreight). */
  const CARRIER_DOMAINS = [
    'tallgrassfreight.com', 'chrobinson.com', 'landstar.com', 'schneider.com', 'werner.com', 'jbhunt.com',
    'knight-swift.com', 'swifttrans.com', 'knighttrans.com', 'uberfreight.com', 'loadsmart.com', 'hubgroup.com',
    'forwardair.com', 'odfl.com', 'estes-express.com', 'saia.com', 'arcb.com', 'abfs.com', 'averitt.com', 'sefl.com',
    'pittohio.com', 'rlcarriers.com', 'aaacooper.com', 'armstrongtransport.com', 'arrivelogistics.com',
    'englandlogistics.com', 'globaltranz.com', 'wwex.com', 'redwoodlogistics.com', 'allenlund.com', 'scotlynn.com',
    'transfix.io', 'daseke.com', 'usxpress.com', 'heartlandexpress.com', 'primeinc.com', 'crst.com', 'marten.com',
    'hirschbach.com', 'westernexpress.com', 'kllm.com', 'crengland.com', 'tforcefreight.com', 'daytonfreight.com',
    'centraltransport.com', 'covenantlogistics.com', 'pamtransport.com', 'ruan.com', 'nfiindustries.com',
    'rxo.com', 'gxo.com', 'coyote.com', 'echo.com', 'tql.com', 'xpo.com',
  ];
  const TRUSTED = new Set([...TRUSTED_EXTRA, ...CARRIER_DOMAINS, ...BRANDS.flatMap((b) => b.domains)]);

  /** Pool used for misspelling detection: official domains with a name long enough to compare. */
  const LOOKALIKE_POOL = [...new Set([...CARRIER_DOMAINS, ...BRANDS.flatMap((b) => b.domains)])]
    .map((domain) => {
      const sld = domain.slice(0, domain.indexOf('.'));
      return { domain, sld, key: lookalikeKey(sld) };
    })
    .filter((e) => e.key.length >= 6);

  // Lure wording ---------------------------------------------------------------

  // Login/verify words used as a label in the host name itself (login-dat.com, secure.x.net)
  const CRED_HOST_RE = /(^|[.-])(login|log-in|logon|signin|sign-in|verify|verification|secure|security|auth|authenticate|confirm|password|sso|recover|recovery|unlock|validate|update|alert|notice|webmail)([.-]|$)/;
  // Same idea inside the path or query
  const CRED_PATH_RE = /(^|[/?&#=._-])(login|logon|signin|sign-in|verify|verification|confirm|password|passwd|credential|credentials|account|unlock|suspended|reactivate|validate|authenticate|session|otp|2fa|mfa|update)([/?&#=._-]|$)/;
  // Freight-industry documents and processes that phishing emails pretend to deliver
  const FREIGHT_LURE_RE = /(ratecon|rate[-_ ]?con(firmation)?|bill[-_ ]?of[-_ ]?lading|(^|[^a-z])bol([^a-z]|$)|(^|[^a-z])pod([^a-z]|$)|proof[-_ ]?of[-_ ]?delivery|load[-_ ]?board|load[-_ ]?(tender|offer|confirmation)|carrier[-_ ]?(packet|setup|set-up|agreement|onboarding|profile)|setup[-_ ]?packet|broker[-_ ]?(packet|agreement)|mc[-_ ]?number|dot[-_ ]?number|operating[-_ ]?authority|factoring|quick[-_ ]?pay|remit(tance)?|detention|lumper|(^|[^a-z])tonu([^a-z]|$)|freight[-_ ]?(invoice|payment|bill)|(^|[^a-z0-9])w-?9([^a-z0-9]|$)|insurance[-_ ]?cert|certificate[-_ ]?of[-_ ]?insurance|(^|[^a-z])coi([^a-z]|$)|notice[-_ ]?of[-_ ]?assignment)/;
  // Document-named subdomains on unknown domains: ratecon.evil.com, invoice.evil.net
  const DOC_SUBDOMAIN_RE = /^(ratecon|rate-?cons?|rate-?confirmations?|rateconfirmation|bols?|pod|pods|invoices?|statements?|remit|remittance|carrier-?packets?|e-?sign|esign|docusign|rc|w9|coi)$/;
  // FMCSA / USDOT / UCR "registration renewal" scams
  const GOV_LURE_RE = /(fmcsa|usdot|us-dot|(^|[^a-z])dot[-_ ]?(number|registration|renewal|update|compliance|authority|filing)|mcs[-_ ]?150|boc[-_ ]?3|(^|[^a-z])ucr([^a-z]|$)|unified[-_ ]?carrier[-_ ]?registration|biennial|(^|[^a-z])safer([^a-z]|$)|hazmat[-_ ]?registration|clearinghouse)/;
  // Invoice fraud: "update our banking details"
  const PAYMENT_CHANGE_RE = /((ach|wire|bank|banking|remit|remittance|payment|payee|vendor|billing)[^a-z]{0,3}[a-z-]{0,12}?(update|change|changed|new|verify|verification|form|details|info|information))|((update|change|new|verify)[^a-z]{0,3}[a-z-]{0,12}?(ach|wire|bank|banking|remit|remittance|payment|payee|vendor|billing))/;
  // Pressure words
  const URGENCY_RE = /(urgent|immediately|suspend|suspended|suspension|reinstate|reactivat|revok|expir|final[-_ ]?notice|overdue|past[-_ ]?due|penalty|deadline|renew(al)?|action[-_ ]?required|limited[-_ ]?time|last[-_ ]?warning)/;
  // Open-redirect parameters
  const REDIRECT_PARAM_RE = /[?&](url|u|redirect|redirect_uri|redirect_url|redir|return|returnurl|return_url|next|dest|destination|target|goto|link|continue|r)=([^&#]+)/i;
  const HTML_DOC_LURE_RE = /(invoice|ratecon|rate|bol|pod|statement|payment|doc|document|scan|voicemail|secure|login|signin|verify|remit)/;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }

  const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

  function isIpLiteral(host) {
    return IPV4_RE.test(host) || host.startsWith('[');
  }

  function isPrivateHost(host) {
    if (!host) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home') ||
        host.endsWith('.corp') || host.endsWith('.test')) return true;
    const m = host.match(IPV4_RE);
    if (m) {
      const a = +m[1], b = +m[2];
      return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) ||
        (a === 100 && b >= 64 && b <= 127);
    }
    return host === '[::1]' || /^\[(fe80|fc|fd)/i.test(host);
  }

  function registrableDomain(host) {
    if (!host || isIpLiteral(host)) return host;
    const labels = host.split('.');
    if (labels.length <= 2) return host;
    const last2 = labels.slice(-2).join('.');
    if (MULTI_SUFFIXES.has(last2)) return labels.slice(-3).join('.');
    return last2;
  }

  function isGovHost(host) {
    return /\.(gov|mil)$/.test(host) || /\.(gov|gob|govt|go|gc)\.[a-z]{2}$/.test(host) || host.endsWith('.gov.uk') || host === 'gc.ca' || host.endsWith('.gc.ca');
  }

  /** Parse the allowlist textarea: one host per line (commas/spaces also accepted). */
  function parseAllowlist(text) {
    const out = new Set();
    for (let item of String(text || '').split(/[\s,;]+/)) {
      item = item.trim().toLowerCase();
      if (!item) continue;
      item = item.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '').replace(/^\*\./, '').replace(/:\d+$/, '');
      if (item && /^[a-z0-9.-]+$/.test(item)) out.add(item);
    }
    return out;
  }

  function matchesAllow(host, allow) {
    if (!allow || allow.size === 0) return false;
    const bare = host.replace(/^www\./, '');
    if (allow.has(host) || allow.has(bare)) return true;
    for (const a of allow) if (bare.endsWith('.' + a)) return true;
    return false;
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }

  /** Trim, un-defang (hxxp, [.]), add https:// when the scheme is missing. */
  function normalizeUrl(input) {
    let s = String(input == null ? '' : input).trim();
    s = s.replace(/^<+|>+$/g, '').replace(/^["'`(]+|["'`),.;]+$/g, '');
    s = s.replace(/^hxxps?/i, (m) => m.toLowerCase().replace('xx', 'tt'))
         .replace(/\[\.\]|\(\.\)|\{\.\}|\[dot\]/gi, '.')
         .replace(/\[:\]/g, ':')
         .replace(/\[\/\]/g, '/');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
    return s;
  }

  function describeAge(days) {
    if (days == null) return null;
    if (days < 1) return 'registered today';
    if (days < 60) return `registered ${days} day${days === 1 ? '' : 's'} ago`;
    if (days < 730) return `registered ${Math.round(days / 30)} months ago`;
    return `registered ${Math.floor(days / 365)} years ago`;
  }

  /** Fold look-alike characters so micr0s0ft-online compares as microsoftonline. */
  function lookalikeKey(s) {
    return String(s).toLowerCase().replace(/-/g, '')
      .replace(/rn/g, 'm').replace(/vv/g, 'w')
      .replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/4/g, 'a')
      .replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'b').replace(/9/g, 'g');
  }

  /** Damerau-Levenshtein distance (adjacent swaps count as one edit), capped at max+1. */
  function editDistance(a, b, max) {
    const n = a.length, m = b.length;
    if (Math.abs(n - m) > max) return max + 1;
    const d = [];
    for (let i = 0; i <= n; i++) { d[i] = new Array(m + 1).fill(0); d[i][0] = i; }
    for (let j = 0; j <= m; j++) d[0][j] = j;
    for (let i = 1; i <= n; i++) {
      let rowMin = Infinity;
      for (let j = 1; j <= m; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
        d[i][j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
    }
    return d[n][m];
  }

  /** "gdfhghsdvf" — keyboard mash used as a unique victim/tracking token. */
  function looksRandom(token) {
    const s = String(token).toLowerCase().replace(/[^a-z]/g, '');
    if (s.length < 7) return false;
    const vowels = (s.match(/[aeiouy]/g) || []).length;
    if (vowels / s.length < 0.2) return true;
    return /[bcdfghjklmnpqrstvwxz]{5,}/.test(s);
  }

  // ── Static analysis ─────────────────────────────────────────────────────────

  /**
   * Analyze a URL without touching the network.
   * @param {string} rawUrl        What the user pasted or the href of a link.
   * @param {{allow?: Set<string>, allowlist?: string}} [options]
   */
  function analyzeUrl(rawUrl, options = {}) {
    const allow = options.allow instanceof Set ? options.allow : parseAllowlist(options.allowlist);
    const url = normalizeUrl(rawUrl);
    const r = {
      input: String(rawUrl == null ? '' : rawUrl),
      url,
      host: '',
      registrable: '',
      https: false,
      trusted: false,
      platform: null,
      brand: null,
      redirectTarget: null,
      riskScore: 0,
      verdict: 'UNKNOWN',
      issues: [],
      tags: [],
    };
    const add = (score, t, m) => { r.riskScore += score; r.issues.push({ t, m }); };
    const info = (m) => r.issues.push({ t: 'i', m });

    let p;
    try {
      p = new URL(url);
    } catch (_) {
      add(20, 'w', 'Not a valid web address');
      return finish(r);
    }

    const proto = p.protocol;
    if (proto === 'mailto:' || proto === 'tel:' || proto === 'sms:') {
      info(`${proto.slice(0, -1)} link — nothing to check`);
      r.tags.push('non-web');
      return finish(r);
    }
    if (proto === 'javascript:' || proto === 'data:' || proto === 'vbscript:' || proto === 'blob:') {
      add(80, 'd', `Script/data URI (${proto}) — can run code or hide the real destination`);
      return finish(r);
    }
    if (proto === 'file:') {
      add(40, 'w', 'Local file link (file:) — opens a file on this computer');
      return finish(r);
    }
    if (proto !== 'https:' && proto !== 'http:') {
      if (['ftp:', 'ftps:', 'sftp:'].includes(proto)) info(`File-transfer link (${proto})`);
      else add(40, 'w', `Unusual protocol: ${proto}`);
      return finish(r);
    }

    const host = p.hostname.toLowerCase();
    const hostText = host.replace(/^www\./, '');
    const labels = host.split('.');
    const tld = '.' + labels[labels.length - 1];
    const reg = registrableDomain(host);
    const isIp = isIpLiteral(host);
    const priv = isPrivateHost(host);
    const pathq = (p.pathname + p.search).toLowerCase();
    const gov = !isIp && isGovHost(host);

    r.host = host;
    r.registrable = reg;
    r.https = proto === 'https:';

    // Hosting platforms (anyone can publish there) override the owner's trust.
    let platform = null;
    const platformHost = PLATFORM_HOSTS.find((h) => host === h || host.endsWith('.' + h));
    if (platformHost) platform = platformHost;
    else if (PLATFORMS.has(reg)) platform = reg;
    if (platform === 'docs.google.com') platform = null; // documents are fine; forms handled below
    if (host === 'docs.google.com' && p.pathname.startsWith('/forms')) platform = 'docs.google.com/forms';
    r.platform = platform;

    const allowHit = !isIp && matchesAllow(host, allow);
    const trusted = !isIp && !platform && (allowHit || gov || TRUSTED.has(reg));
    r.trusted = trusted;
    if (trusted) {
      r.tags.push('trusted');
      r.issues.push({ t: 'ok', m: allowHit ? `${reg} is on your company allowlist` : gov ? `${reg} is a government domain` : `${reg} is a recognized official domain` });
    }

    // Transport ---------------------------------------------------------------
    if (!r.https) {
      if (priv) info('Plain HTTP on a private/internal address');
      else add(15, 'w', 'Plain HTTP — the connection is not encrypted');
    }
    if (p.port && !priv) add(10, 'w', `Non-standard port :${p.port}`);

    // Host name tricks ---------------------------------------------------------
    if (p.username || p.password) add(45, 'd', `The text before "@" is a decoy — the real site is ${host}`);
    if (isIp) {
      if (priv) info(`Private network address (${host})`);
      else add(30, 'd', 'Raw IP address instead of a domain name');
    }
    if (/(^|\.)xn--/.test(host)) add(30, 'd', 'Internationalized domain (punycode) — may imitate a Latin-letter name');
    if (!isIp && SUSPICIOUS_TLDS.has(tld)) add(20, 'w', `"${tld}" domains are cheap and heavily abused for spam and phishing`);
    if (SHORTENERS.has(reg)) { add(20, 'w', 'Link shortener — the real destination is hidden'); r.tags.push('shortener'); }
    if (platform) add(15, 'w', `Hosted on a shared/free platform (${platform}) — anyone can publish pages there`);
    if (!isIp && host.length > 50) add(10, 'w', `Very long host name (${host.length} characters)`);
    if (!isIp && labels.length >= 5) add(10, 'w', `Deeply nested subdomains (${labels.length - 1} levels)`);
    const hyphens = (host.match(/-/g) || []).length;
    if (hyphens >= 3) add(8, 'w', `Many hyphens in the domain (${hyphens})`);

    if (!isIp && !trusted) {
      const sub = host.length > reg.length ? host.slice(0, host.length - reg.length - 1) : '';
      if (sub && sub.split('.').some((l) => EMBEDDED_TLDS.has(l))) {
        add(20, 'd', `Another domain name is embedded in the subdomain — the real site is ${reg}`);
      }
    }

    // Government / FMCSA impersonation ------------------------------------------
    if (!gov && !trusted) {
      if (GOV_LURE_RE.test(hostText)) {
        add(55, 'd', 'Domain mentions FMCSA / USDOT / UCR / MCS-150 but is not a .gov site — typical registration-renewal scam');
        r.tags.push('gov-lure');
      } else if (GOV_LURE_RE.test(pathq)) {
        add(30, 'w', 'Link refers to FMCSA / USDOT / UCR filings but is not on a .gov site — official filings happen only on fmcsa.dot.gov');
        r.tags.push('gov-lure');
      } else if (/(^|[.-])gov([.-]|$)/.test(hostText)) {
        add(30, 'd', 'Uses "gov" in the name but is not a government domain');
      }
    }

    // Brand impersonation -------------------------------------------------------
    if (!isIp && !trusted) {
      const brandHost = platform && hostText.endsWith(platform) ? hostText.slice(0, Math.max(0, hostText.length - platform.length - 1)) : hostText;
      const hit = brandHost ? BRANDS.find((b) => b.pattern.test(brandHost)) : null;
      if (hit && !hit.domains.includes(reg)) {
        r.brand = hit.name;
        r.tags.push('brand');
        const sld = reg.slice(0, reg.indexOf('.') > 0 ? reg.indexOf('.') : reg.length);
        const sameWordOtherEnding = !platform && hit.domains.some((d) => d.slice(0, d.indexOf('.')) === sld);
        if (platform) add(30, 'd', `Mentions ${hit.name} but is a user page on ${platform} (official site: ${hit.domains[0]})`);
        else if (sameWordOtherEnding && GENERIC_BRAND_NAMES.has(hit.name)) add(20, 'w', `Same name as ${hit.domains[0]} but a different ending (${reg}) — may be an unrelated company; verify before trusting`);
        else if (sameWordOtherEnding) add(40, 'd', `Same name as ${hit.domains[0]} but a different ending (${reg})`);
        else add(50, 'd', `Looks like ${hit.name} but is hosted on ${reg} (official site: ${hit.domains[0]})`);
      } else if (platform) {
        // sites.google.com/view/dat-carrier-login — the brand hides in the path
        const pathKey = p.pathname.toLowerCase().replace(/[/_]+/g, '.');
        const pathHit = BRANDS.find((b) => b.pattern.test(pathKey));
        if (pathHit) {
          r.brand = pathHit.name;
          r.tags.push('brand');
          add(30, 'd', `A page on ${platform} named after ${pathHit.name} — the real ${pathHit.name} lives at ${pathHit.domains[0]}`);
        }
      }
    }

    // Misspelled / re-suffixed well-known company domains --------------------------
    if (!isIp && !trusted && !platform && !r.brand) {
      const sld = reg.slice(0, reg.indexOf('.') > 0 ? reg.indexOf('.') : reg.length);
      const key = lookalikeKey(sld);
      if (key.length >= 6) {
        for (const cand of LOOKALIKE_POOL) {
          if (cand.key === key) {
            if (key.length >= 8) {
              r.lookalike = cand.domain;
              r.tags.push('lookalike');
              if (sld.replace(/-/g, '') === cand.sld.replace(/-/g, '')) {
                add(40, 'w', `Same name as ${cand.domain} but a different ending (${reg}) — verify before trusting`);
              } else {
                add(50, 'd', `Imitates ${cand.domain} with look-alike characters (this link goes to ${reg})`);
              }
            }
            break;
          }
          const maxEdits = key.length >= 12 ? 2 : key.length >= 8 ? 1 : 0;
          if (maxEdits && editDistance(key, cand.key, maxEdits) <= maxEdits) {
            r.lookalike = cand.domain;
            r.tags.push('lookalike');
            add(50, 'd', `Looks like a misspelling of ${cand.domain} (this link goes to ${reg})`);
            break;
          }
        }
      }
    }

    // File types ----------------------------------------------------------------
    const extMatch = p.pathname.toLowerCase().match(/\.[a-z0-9]{1,5}$/);
    const ext = extMatch ? extMatch[0] : '';
    if (ext && DANGEROUS_EXT.has(ext)) add(40, 'd', `Links directly to a ${ext} file — it can run programs on this computer`);
    else if (ext && ARCHIVE_EXT.has(ext)) add(10, 'w', `Links to an archive (${ext}) — a common wrapper for malware ("rate_confirmation.zip")`);
    else if (ext && (ext === '.html' || ext === '.htm' || ext === '.shtml') && !trusted && HTML_DOC_LURE_RE.test(pathq)) {
      add(10, 'w', 'An HTML file posing as a document — a frequent phishing trick');
    }

    // Lure wording ----------------------------------------------------------------
    if (!trusted) {
      if (CRED_HOST_RE.test(hostText)) add(20, 'w', 'Login / verify / secure-style words in the domain name itself');
      else if (CRED_PATH_RE.test(pathq)) add(8, 'w', 'Login / verify / account wording in the link path');
      const subLabels = !isIp && host.length > reg.length ? host.slice(0, host.length - reg.length - 1).split('.').filter((l) => l && l !== 'www') : [];
      const docLabel = subLabels.find((l) => DOC_SUBDOMAIN_RE.test(l));
      if (docLabel) {
        add(40, 'd', `"${docLabel}." subdomain on an unrecognized domain (${reg}) — rate confirmations, BOLs and invoices come from your broker's own system, not from document-named links`);
        r.tags.push('freight-lure');
      } else if (FREIGHT_LURE_RE.test(hostText)) {
        add(25, 'w', 'Freight-industry words (rate con, carrier packet, factoring…) used as the domain name itself — common for throw-away scam domains');
        r.tags.push('freight-lure');
      } else if (FREIGHT_LURE_RE.test(pathq)) {
        add(12, 'w', 'Freight-industry lure words (rate con, BOL, carrier packet, factoring…) on an unrecognized domain');
        r.tags.push('freight-lure');
      }
      if (PAYMENT_CHANGE_RE.test(hostText) || PAYMENT_CHANGE_RE.test(pathq)) {
        add(15, 'w', 'Payment / ACH / remittance change wording — classic invoice-fraud lure');
      }
      if (URGENCY_RE.test(hostText) || URGENCY_RE.test(pathq)) add(10, 'w', 'Pressure wording (urgent, suspended, renewal, final notice…)');
    }

    // Machine-generated tokens --------------------------------------------------
    if (!trusted) {
      const tokens = [];
      for (const key of p.searchParams.keys()) tokens.push(key);
      for (const seg of p.pathname.split('/')) if (seg.length >= 8 && !/\.[a-z0-9]{1,5}$/i.test(seg)) tokens.push(seg);
      const odd = tokens.filter(looksRandom);
      if (odd.length) add(15, 'w', `Random-looking names in the link (${odd.slice(0, 2).join(', ')}) — typical unique tracking / victim token`);
    }

    // Obfuscation & redirects ---------------------------------------------------
    const enc = (pathq.match(/%[0-9a-f]{2}/g) || []).length;
    if (enc >= 8) add(10, 'w', `Heavy percent-encoding (${enc} escapes) can hide the real target`);
    const rp = REDIRECT_PARAM_RE.exec(p.search);
    if (rp) {
      const target = safeDecode(rp[2]);
      if (/^https?:\/\//i.test(target)) {
        try {
          const th = new URL(target).hostname.toLowerCase();
          if (registrableDomain(th) !== reg) {
            add(15, 'w', `Forwards to another site after loading: ${th}`);
            r.redirectTarget = target;
          }
        } catch (_) { /* ignore */ }
      }
    }

    return finish(r);
  }

  function finish(r) {
    r.riskScore = Math.min(100, Math.max(0, Math.round(r.riskScore)));
    r.verdict = r.tags.includes('non-web') ? 'SAFE' : verdictFor(r.riskScore);
    return r;
  }

  return Object.freeze({
    VERSION, DEFAULT_SETTINGS, VERDICTS, THRESHOLDS, SEVERITY, BRANDS,
    DANGEROUS_EXT, ARCHIVE_EXT, RISKY_ATTACHMENT_EXT,
    analyzeUrl, verdictFor, normalizeUrl, registrableDomain, isIpLiteral, isPrivateHost,
    isGovHost, parseAllowlist, matchesAllow, escapeHtml, describeAge,
    lookalikeKey, editDistance, looksRandom,
    isTrustedDomain: (reg) => TRUSTED.has(reg),
  });
})();
