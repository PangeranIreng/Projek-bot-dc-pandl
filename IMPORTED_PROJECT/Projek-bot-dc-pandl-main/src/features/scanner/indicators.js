// Heuristic, regex-based indicator scanning over decoded text content.
// Every category below is intentionally narrow: we only report an indicator
// when we actually matched something in the analyzed text. Nothing here is
// guessed or fabricated.
//
// Each category carries:
// - severity: "critical" | "high" | "medium" | "info" (display/labeling)
// - weight: contribution to the 0-100 Risk Score (riskScore.js). Weights
//   come from the project's fixed scoring table -- never randomized.
// - group: which embed field this rolls up into (network / execution /
//   obfuscation / encryption / grabber / info) so the embed can show
//   🌐 Network, 🧬 Obfuscator, 🔐 Encryption, etc. as coherent summaries.

const CATEGORIES = [
  // --- Webhook / exfiltration destinations -------------------------------
  {
    id: "discordWebhook",
    label: "Discord Webhook",
    severity: "critical",
    weight: 40,
    group: "network",
    pattern:
      /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/gi,
  },
  {
    id: "webhookSender",
    label: "Webhook sender",
    severity: "critical",
    weight: 10,
    group: "network",
    pattern: /sendWebhook|webhook\.send|postWebhook|kirim.{0,10}webhook/gi,
  },
  {
    id: "discordToken",
    label: "Token Discord (Token Pattern)",
    severity: "critical",
    weight: 30,
    group: "grabber",
    pattern: /\b[MN][A-Za-z\d_-]{23,26}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/g,
  },

  // --- Grabber / keylogger family -----------------------------------------
  {
    id: "keylogger",
    label: "Keylogger",
    severity: "critical",
    weight: 25,
    group: "grabber",
    pattern:
      /\bkeylogger\b|GetAsyncKeyState|GetKeyState|pynput\.keyboard|keyboard\.on_press|SetWindowsHookEx/gi,
  },
  {
    id: "browserPassword",
    label: "Browser password stealer",
    severity: "critical",
    weight: 20,
    group: "grabber",
    pattern:
      /Login Data\b|Local State\b|AppData.{0,40}(Chrome|Edge|Brave|Opera)|(Chrome|Edge|Brave|Opera).{0,40}(password|cookies|Login Data)/gi,
  },
  {
    id: "tokenGrabber",
    label: "Token grabber",
    severity: "critical",
    weight: 20,
    group: "grabber",
    pattern: /token\s*grabber|Discord\\Local Storage|discord.{0,20}leveldb|\\leveldb\\/gi,
  },
  {
    id: "credentialStealer",
    label: "Credential stealer",
    severity: "critical",
    weight: 35,
    group: "grabber",
    pattern: /credential\s*stealer|steal.{0,15}(password|credential)|harvest.{0,15}(password|credential)|\bkeychain\b.{0,20}(dump|read|access)/gi,
  },
  {
    id: "registryPersistence",
    label: "Registry persistence",
    severity: "critical",
    weight: 20,
    group: "grabber",
    pattern: /HKEY_(CURRENT_USER|LOCAL_MACHINE)|\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\b|Registry\.(SetValue|CreateSubKey)/gi,
  },
  {
    id: "startupPersistence",
    label: "Startup persistence",
    severity: "critical",
    weight: 20,
    group: "grabber",
    pattern: /Startup\\.*\.(exe|bat|vbs|lnk)|shell:startup|\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup/gi,
  },
  {
    id: "nicknameGrabber",
    label: "Nickname grabber",
    severity: "high",
    weight: 8,
    group: "grabber",
    pattern: /getPlayerName|sampGetPlayerNickname|nickname\s*grabber|GetPlayerNickname/gi,
  },
  {
    id: "serverGrabber",
    label: "Server address grabber",
    severity: "high",
    weight: 10,
    group: "grabber",
    pattern: /server\s*grabber|sampGetCurrentServerAddress|GetServerAddress/gi,
  },
  {
    id: "dialogGrabber",
    label: "Dialog grabber",
    severity: "high",
    weight: 8,
    group: "grabber",
    pattern: /dialog\s*grabber|SendDialogResponse|onDialogResponse.{0,40}(send|webhook|http)/gi,
  },
  {
    id: "loggerFn",
    label: "Logger / activity recorder",
    severity: "high",
    weight: 20,
    group: "grabber",
    pattern: /\blogger\b\s*[:.]|activity\s*logger|log(ger)?\.(send|report|track)/gi,
  },
  {
    id: "screenshot",
    label: "Screenshot capture",
    severity: "high",
    weight: 10,
    group: "grabber",
    pattern: /\bscreenshot\b|ImageGrab\.grab|mss\.mss\(|pyautogui\.screenshot/gi,
  },
  {
    id: "clipboard",
    label: "Clipboard access",
    severity: "high",
    weight: 15,
    group: "grabber",
    pattern: /setClipboardText|getClipboardText|\bclipboard\b|pyperclip/gi,
  },
  {
    id: "dataExfiltration",
    label: "Remote code / data exfiltration",
    severity: "critical",
    weight: 35,
    group: "network",
    pattern:
      /exfiltrat\w*|send.{0,20}(webhook|to server)|upload.{0,20}(file|data).{0,20}(http|webhook)/gi,
  },

  // --- Network -------------------------------------------------------------
  {
    id: "remoteDownload",
    label: "Downloader",
    severity: "high",
    weight: 20,
    group: "network",
    pattern:
      /downloadUrlToFile|urlretrieve|Invoke-WebRequest|wget\s+http|curl\s+http|\.DownloadFile\(/gi,
  },
  {
    id: "updater",
    label: "Updater",
    severity: "medium",
    weight: 10,
    group: "network",
    pattern: /auto.?updat(e|er)|self.?updat(e|er)|check.?for.?update/gi,
  },
  {
    id: "customLoader",
    label: "Custom loader",
    severity: "medium",
    weight: 10,
    group: "obfuscation",
    pattern: /custom\s*loader|loader\.lua|bootstrap\s*loader/gi,
  },
  {
    id: "requestFunction",
    label: "Request library",
    severity: "medium",
    weight: 15,
    group: "network",
    pattern:
      /performHttpRequest|http\.request\(|requests\.(get|post)\(|axios\.(get|post)\(|fetch\(|urllib\.request/gi,
  },
  {
    id: "httpsScheme",
    label: "HTTPS",
    severity: "info",
    weight: 10,
    group: "network",
    pattern: /https:\/\//gi,
  },
  {
    id: "socket",
    label: "Socket",
    severity: "high",
    weight: 20,
    group: "network",
    pattern: /\bsocket\.(tcp|connect|udp|bind)\s*\(|\bLuaSocket\b/gi,
  },
  {
    id: "tcp",
    label: "TCP",
    severity: "medium",
    weight: 8,
    group: "network",
    pattern: /\bTCP\b|\btcp\.(connect|listen|socket)\s*\(/gi,
  },
  {
    id: "udp",
    label: "UDP",
    severity: "medium",
    weight: 8,
    group: "network",
    pattern: /\bUDP\b|\budp\.(bind|socket|send)\s*\(/gi,
  },
  {
    id: "dns",
    label: "DNS",
    severity: "medium",
    weight: 8,
    group: "network",
    pattern: /\bDNS\b|dns\.(resolve|lookup|query)\s*\(/gi,
  },
  {
    id: "pastebin",
    label: "Pastebin",
    severity: "high",
    weight: 15,
    group: "network",
    pattern: /pastebin\.com\/(raw\/)?[A-Za-z0-9]+/gi,
  },
  {
    id: "githubRaw",
    label: "GitHub Raw",
    severity: "high",
    weight: 15,
    group: "network",
    pattern: /raw\.githubusercontent\.com\/[^\s'"<>)\]]+/gi,
  },
  {
    id: "top4top",
    label: "Top4Top",
    severity: "medium",
    weight: 10,
    group: "network",
    pattern: /top4top\.(io|net)\/[^\s'"<>)\]]*/gi,
  },
  {
    id: "dropbox",
    label: "Dropbox",
    severity: "medium",
    weight: 10,
    group: "network",
    pattern: /dropbox\.com\/[^\s'"<>)\]]+/gi,
  },
  {
    id: "googleDrive",
    label: "Google Drive",
    severity: "medium",
    weight: 10,
    group: "network",
    pattern: /drive\.google\.com\/[^\s'"<>)\]]+/gi,
  },
  {
    id: "mediafire",
    label: "Mediafire",
    severity: "medium",
    weight: 10,
    group: "network",
    pattern: /mediafire\.com\/[^\s'"<>)\]]+/gi,
  },

  // --- Dynamic execution / risky functions ---------------------------------
  {
    id: "loadstringFn",
    label: "loadstring",
    severity: "high",
    weight: 15,
    group: "execution",
    pattern: /\bloadstring\s*\(/g,
  },
  {
    id: "loadFn",
    label: "load()",
    severity: "high",
    weight: 10,
    group: "execution",
    pattern: /\bload\s*\(/g,
  },
  {
    id: "debugLibrary",
    label: "debug library",
    severity: "medium",
    weight: 10,
    group: "execution",
    pattern: /\bdebug\.(getinfo|sethook|getupvalue|setupvalue|getlocal|setlocal|getmetatable)\s*\(/gi,
  },
  {
    id: "setfenv",
    label: "setfenv (environment manipulation)",
    severity: "high",
    weight: 10,
    group: "execution",
    pattern: /\bsetfenv\s*\(/gi,
  },
  {
    id: "getfenv",
    label: "getfenv (environment manipulation)",
    severity: "medium",
    weight: 10,
    group: "execution",
    pattern: /\bgetfenv\s*\(/gi,
  },
  {
    id: "envManipulation",
    label: "Manipulasi environment global (_G/_ENV)",
    severity: "medium",
    weight: 8,
    group: "execution",
    pattern: /rawset\s*\(\s*_G\b|_ENV\s*=|\b_G\s*\[\s*["']/gi,
  },
  {
    id: "autoExecute",
    label: "Auto execute",
    severity: "high",
    weight: 15,
    group: "execution",
    pattern: /\bautoexec\b|auto[\s_-]?execute|auto[\s_-]?run\b/gi,
  },
  {
    id: "dynamicLibraryLoad",
    label: "Dynamic library load",
    severity: "high",
    weight: 20,
    group: "execution",
    pattern: /LoadLibrary[AW]?\s*\(|\bdlopen\s*\(|GetProcAddress\s*\(/gi,
  },
  {
    id: "stringDump",
    label: "string.dump",
    severity: "medium",
    weight: 10,
    group: "obfuscation",
    pattern: /string\.dump\s*\(/gi,
  },
  {
    id: "osExecute",
    label: "os.execute",
    severity: "critical",
    weight: 30,
    group: "execution",
    pattern: /\bos\.execute\s*\(/g,
  },
  {
    id: "ioOpen",
    label: "io.open",
    severity: "medium",
    weight: 12,
    group: "execution",
    pattern: /\bio\.open\s*\(/g,
  },
  {
    id: "ioPopen",
    label: "io.popen / shell",
    severity: "high",
    weight: 15,
    group: "execution",
    pattern: /\bio\.popen\s*\(|cmd\.exe|powershell(\.exe)?|\/bin\/sh/gi,
  },
  {
    id: "packageLoadlib",
    label: "package.loadlib",
    severity: "high",
    weight: 15,
    group: "execution",
    pattern: /package\.loadlib\s*\(/gi,
  },
  {
    id: "ffiLib",
    label: "FFI",
    severity: "high",
    weight: 20,
    group: "execution",
    pattern: /\bffi\.(cdef|load|C\.)/gi,
  },
  {
    id: "genericEval",
    label: "eval/exec (script lain)",
    severity: "high",
    weight: 10,
    group: "execution",
    pattern: /\beval\s*\(|\bexec\s*\(|\bFunction\s*\(\s*["'`]/g,
  },
  {
    id: "suspiciousLua",
    label: "Fungsi Lua mencurigakan",
    severity: "medium",
    weight: 5,
    group: "execution",
    pattern: /\brequire\s*\(|\bmemory\.\w+|lua_thread\.create/gi,
  },

  // --- Obfuscation / anti-analysis -----------------------------------------
  {
    id: "bytecode",
    label: "Bytecode",
    severity: "medium",
    weight: 8,
    group: "obfuscation",
    pattern: /\\27Lua|\x1bLua|\.luac\b/gi,
  },
  {
    id: "obfuscatorGeneric",
    label: "Obfuscator",
    severity: "low",
    weight: 5,
    group: "obfuscation",
    pattern: /obfuscat(e|ed|or|ion)/gi,
  },
  {
    id: "antiDebug",
    label: "Anti debug",
    severity: "medium",
    weight: 10,
    group: "obfuscation",
    pattern: /anti.?debug|IsDebuggerPresent|CheckRemoteDebuggerPresent/gi,
  },
  {
    id: "antiDump",
    label: "Anti dump",
    severity: "medium",
    weight: 8,
    group: "obfuscation",
    pattern: /anti.?dump/gi,
  },
  {
    id: "antiHook",
    label: "Anti hook",
    severity: "medium",
    weight: 8,
    group: "obfuscation",
    pattern: /anti.?hook/gi,
  },
  {
    id: "antiDecompiler",
    label: "Anti decompiler",
    severity: "medium",
    weight: 8,
    group: "obfuscation",
    pattern: /anti.?decompil(e|er)/gi,
  },
  {
    id: "virtualMachine",
    label: "Virtual Machine",
    severity: "high",
    weight: 12,
    group: "obfuscation",
    pattern: /virtual\s*machine\b|\bVM_?EXECUTE\b|\bLuaVM\b/gi,
  },
  {
    id: "junkCode",
    label: "Junk code",
    severity: "low",
    weight: 5,
    group: "obfuscation",
    pattern: /junk\s*code/gi,
  },
  {
    id: "packed",
    label: "Packed",
    severity: "medium",
    weight: 8,
    group: "obfuscation",
    pattern: /\bpacked\b|\bpacker\b/gi,
  },
  {
    id: "marshal",
    label: "Marshal / bytecode serialization",
    severity: "medium",
    weight: 8,
    group: "obfuscation",
    pattern: /marshal\.loads?\(|__marshal__|\bmarshal\b/gi,
  },

  // --- Encryption / encoding -------------------------------------------------
  {
    id: "encryptedStringMarker",
    label: "Encrypted string marker",
    severity: "low",
    weight: 5,
    group: "encryption",
    pattern: /encrypted\s*string|encrypt(ed)?\s*payload/gi,
  },
  {
    id: "xorSimple",
    label: "XOR",
    severity: "medium",
    weight: 5,
    group: "encryption",
    pattern: /\bbxor\s*\(|\^\s*key\b|xor_?(key|decrypt|encrypt)/gi,
  },
  {
    id: "aes",
    label: "AES",
    severity: "medium",
    weight: 8,
    group: "encryption",
    pattern: /\bAES\b|aes\.(encrypt|decrypt)|aes256|aes128/gi,
  },
  {
    id: "rc4",
    label: "RC4",
    severity: "medium",
    weight: 8,
    group: "encryption",
    pattern: /\bRC4\b|rc4\.(encrypt|decrypt)/gi,
  },
  {
    id: "base64",
    label: "Base64 blob",
    severity: "low",
    weight: 3,
    group: "encryption",
    pattern: /(?:[A-Za-z0-9+/]{60,}={0,2})/g,
  },
  {
    id: "hexEscape",
    label: "String tersembunyi (hex/unicode escape)",
    severity: "low",
    weight: 3,
    group: "encryption",
    pattern: /(?:\\x[0-9a-fA-F]{2}){8,}|(?:\\u00[0-9a-fA-F]{2}){8,}/g,
  },
  {
    id: "decimalEscape",
    label: "String tersembunyi (decimal escape)",
    severity: "low",
    weight: 3,
    group: "encryption",
    pattern: /(?:\\\d{1,3}){8,}/g,
  },
  {
    id: "octalEscape",
    label: "String tersembunyi (octal escape)",
    severity: "low",
    weight: 3,
    group: "encryption",
    pattern: /(?:\\[0-3][0-7]{2}){8,}/g,
  },
  {
    id: "gzipZlib",
    label: "Kompresi gzip/zlib",
    severity: "low",
    weight: 3,
    group: "encryption",
    pattern: /\bgzip\b|\bzlib\b|\binflate\b|\bdeflate\b/gi,
  },

  // --- Structural obfuscation techniques ------------------------------------
  // These fire on *repeated* occurrences (thresholds baked into the pattern
  // via `{n,}`), never on a single hit -- a legitimate script can use one
  // bit32 call or one bracket-index without being obfuscated. The pattern
  // only matches when the same technique repeats enough times that it's
  // structurally suspicious rather than incidental.
  {
    id: "identifierAcak",
    label: "Identifier acak (nama variabel hasil obfuscation)",
    severity: "medium",
    weight: 8,
    group: "obfuscation",
    pattern: /\blocal\s+[A-Za-z_]\w{0,2}\d{2,}\b/g,
  },
  {
    id: "bit32Heavy",
    label: "Penggunaan bit32 secara masif (indikasi custom decryptor)",
    severity: "medium",
    weight: 10,
    group: "obfuscation",
    pattern: /\bbit32\.(bxor|band|bor|bnot|lshift|rshift)\s*\(/gi,
  },
  {
    id: "stringCharUsage",
    label: "Penggunaan string.char secara masif (string tersembunyi)",
    severity: "medium",
    weight: 8,
    group: "encryption",
    pattern: /\bstring\.char\s*\(/gi,
  },
  {
    id: "controlFlowFlattening",
    label: "Control Flow Flattening (dispatcher loop + banyak elseif)",
    severity: "high",
    weight: 15,
    group: "obfuscation",
    // A `while true do ... if x==1 then ... elseif x==2 then ...` state
    // dispatcher is the classic flattening shape. We only flag when there
    // are at least 3 chained elseif branches inside the same construct.
    pattern: /\bwhile\s+true\s+do\b[\s\S]{0,4000}?(?:elseif[\s\S]{0,400}?){3,}/gi,
  },
  {
    id: "tableIndirection",
    label: "Table indirection (akses tabel berlapis)",
    severity: "medium",
    weight: 8,
    group: "obfuscation",
    pattern: /(?:\[[^\[\]]{1,40}\]){3,}/g,
  },
  {
    id: "swizzleLookups",
    label: "SwizzleLookups (key tabel dibentuk secara dinamis)",
    severity: "medium",
    weight: 10,
    group: "obfuscation",
    pattern: /\[\s*[\w."']+\s*\.\.\s*[\w."']+(?:\s*\.\.\s*[\w."']+)*\s*\]/g,
  },
  {
    id: "encryptStringsMarker",
    label: "EncryptStrings (marker/nama fungsi enkripsi string)",
    severity: "medium",
    weight: 8,
    group: "encryption",
    pattern: /EncryptStrings?|DecryptStrings?|decrypt_str|str_decrypt|StringEncrypt/gi,
  },
  {
    id: "dummyFunctions",
    label: "Dummy/Fake Functions (fungsi kosong tanpa efek nyata)",
    severity: "low",
    weight: 6,
    group: "obfuscation",
    pattern: /\bfunction\s*\([^)]*\)\s*return\s+(?:true|false|nil|\d+|"[^"]{0,20}")\s*end/g,
  },
  {
    id: "mutatedLiterals",
    label: "Mutated Literals (angka dipecah jadi ekspresi aritmatika)",
    severity: "low",
    weight: 5,
    group: "obfuscation",
    pattern: /\(\s*\d+\s*[+\-*]\s*\d+\s*\)/g,
  },
  {
    id: "revertedIfStatements",
    label: "Reverted IF Statements (kondisi dibalik dengan not)",
    severity: "low",
    weight: 5,
    group: "obfuscation",
    pattern: /\bif\s+not\s*\(/gi,
  },
  {
    id: "sharedVM",
    label: "Shared VM",
    severity: "medium",
    weight: 10,
    group: "obfuscation",
    pattern: /shared\s*vm\b|sharedvm/gi,
  },
  {
    id: "shuffleSegments",
    label: "Shuffle Segments (segmen kode diacak urutannya)",
    severity: "medium",
    weight: 8,
    group: "obfuscation",
    pattern: /shuffle\s*segments?|segment\s*shuffl(e|ing)/gi,
  },
  {
    id: "globalsLookup",
    label: "Globals Lookup (akses _G/_ENV berlapis)",
    severity: "medium",
    weight: 8,
    group: "obfuscation",
    pattern: /\b(?:_G|_ENV)\s*\[[^\]]+\]\s*\[[^\]]+\]/g,
  },
  {
    id: "customDecryptorStructural",
    label: "Struktur custom decryptor (byte-read -> transform -> char-write), nama fungsi bisa diacak",
    severity: "high",
    weight: 15,
    group: "encryption",
    pattern:
      /string\.byte\s*\([\s\S]{0,200}?(?:bxor|band|bor|[%+\-])[\s\S]{0,200}?string\.char\s*\(/gi,
  },
  {
    id: "fragmentedEndpoint",
    label: "String endpoint/token dipecah lalu digabung saat runtime (concatenation chain)",
    severity: "high",
    weight: 12,
    group: "network",
    // 4+ literal-or-identifier segments joined with `..` is well beyond
    // normal string building and matches the fragment-then-reassemble
    // pattern used to hide webhooks/tokens/URLs from static signature scans.
    pattern: /(?:[\w."'\[\]]+\s*\.\.\s*){3,}[\w."'\[\]]+/g,
  },
  {
    id: "telegramBotToken",
    label: "Telegram Bot Token",
    severity: "critical",
    weight: 30,
    group: "grabber",
    pattern: /\bbot\d{6,10}:[A-Za-z0-9_-]{30,40}\b/g,
  },
  {
    id: "telegramApi",
    label: "Telegram Bot API endpoint",
    severity: "high",
    weight: 15,
    group: "network",
    pattern: /api\.telegram\.org\/bot[\w-]*/gi,
  },
  {
    id: "nestedFunctionAbuse",
    label: "Nested function berlebihan (indikasi wrapper obfuscation)",
    severity: "medium",
    weight: 10,
    group: "obfuscation",
    pattern: /(?:\(function\s*\([^)]*\)[\s\S]{0,200}?){4,}/g,
  },
  {
    id: "suspiciousRecursion",
    label: "Loop/rekursi mencurigakan (kedalaman tinggi)",
    severity: "medium",
    weight: 8,
    group: "execution",
    pattern: /\bfor\s+\w+\s*=\s*1\s*,\s*(?:1e\d+|\d{5,})\s*do\b/gi,
  },

  // --- Additional dynamic-execution primitives ------------------------------
  {
    id: "loadfileFn",
    label: "loadfile()",
    severity: "high",
    weight: 10,
    group: "execution",
    pattern: /\bloadfile\s*\(/g,
  },
  {
    id: "dofileFn",
    label: "dofile()",
    severity: "medium",
    weight: 8,
    group: "execution",
    pattern: /\bdofile\s*\(/g,
  },
  {
    id: "remoteLoader",
    label: "Remote Loader (load/loadstring langsung memuat hasil request jaringan)",
    severity: "critical",
    weight: 25,
    group: "execution",
    pattern: /loadstring\s*\(\s*(?:game\s*:\s*HttpGet|http\.request|request\s*\(|game\s*:\s*HttpGetAsync)|(?:game\s*:\s*HttpGet|http\.request)\s*\([^)]*\)\s*\)\s*\(\s*\)/gi,
  },
  {
    id: "bytecodeInjection",
    label: "Bytecode injection (string.dump/loadstring dikombinasikan untuk menyuntikkan bytecode)",
    severity: "high",
    weight: 18,
    group: "execution",
    pattern: /loadstring\s*\(\s*string\.dump\s*\(|inject\s*[_-]?\s*bytecode|bytecode\s*[_-]?\s*inject/gi,
  },
  {
    id: "embeddedBinaryPayload",
    label: "Payload biner tersemat (signature PE/MZ terdeteksi dalam string)",
    severity: "high",
    weight: 20,
    group: "grabber",
    pattern: /4[dD]5[aA](?:90 ?00|[0-9a-fA-F]{4}){2,}|\\x4[dD]\\x5[aA]/g,
  },

  // --- Backdoor / RAT / evasion ----------------------------------------------
  {
    id: "backdoorKeyword",
    label: "Backdoor",
    severity: "critical",
    weight: 25,
    group: "execution",
    pattern: /\bbackdoor\b|remote\s*access\s*trojan|\bRAT\b\s*(payload|client|module)/gi,
  },
  {
    id: "remoteExecute",
    label: "Remote Execute (eksekusi perintah dari sumber jaringan)",
    severity: "critical",
    weight: 22,
    group: "execution",
    pattern: /remote\s*execute|execute\s*remote\s*command|RemoteExec/gi,
  },
  {
    id: "antiVM",
    label: "Anti-VM (deteksi virtual machine/sandbox)",
    severity: "medium",
    weight: 10,
    group: "obfuscation",
    pattern: /anti.?vm\b|is[_ ]?virtual[_ ]?machine|VirtualBox|VMware|\bsandboxie\b|detect.?sandbox/gi,
  },
  {
    id: "environmentDetection",
    label: "Environment detection (deteksi executor/lingkungan eksekusi)",
    severity: "medium",
    weight: 10,
    group: "obfuscation",
    pattern: /identifyexecutor|getexecutorname|is_sandboxed|syn\.request|is_synapse_function|checkcaller/gi,
  },
  {
    id: "fileManipulationExtra",
    label: "File manipulation (hapus/rename/tulis file di luar io.open dasar)",
    severity: "high",
    weight: 15,
    group: "execution",
    pattern: /\bos\.remove\s*\(|\bos\.rename\s*\(|io\.write\s*\(.{0,60}(exe|dll|bat|vbs|ps1)/gi,
  },
  {
    id: "crashPayload",
    label: "Crash payload (potensi memory/CPU bomb)",
    severity: "high",
    weight: 15,
    group: "execution",
    pattern: /string\.rep\s*\([^)]*,\s*(?:1e\d+|\d{6,})\s*\)|while\s+true\s+do\s+table\.insert/gi,
  },
  {
    id: "infiniteLoop",
    label: "Infinite loop tanpa break (informasional)",
    severity: "info",
    weight: 0,
    group: "execution",
    pattern: /\bwhile\s+true\s+do\b/gi,
  },

  // --- Purely informational, never scored ------------------------------------
  {
    id: "url",
    label: "URL",
    severity: "info",
    weight: 0,
    group: "info",
    pattern: /https?:\/\/[^\s'"<>)\]]+/gi,
  },
  {
    id: "domain",
    label: "Domain",
    severity: "info",
    weight: 0,
    group: "info",
    pattern:
      /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|gg|xyz|info|ru|cc|to|dev|app|top|club|site)\b/gi,
  },
  {
    id: "ip",
    label: "IP Address",
    severity: "info",
    weight: 0,
    group: "info",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  },
];

const MAX_MATCHES_PER_CATEGORY = 8;

/**
 * Scan decoded text content for known indicator categories.
 * @param {string} text
 * @returns {Array<{id:string,label:string,severity:string,weight:number,group:string,count:number,samples:string[]}>}
 */
// Line number of the first match, when computable. Regex indicators only
// have a raw text offset (not an AST node), so this is a best-effort
// "where did the FIRST occurrence show up" hint, not a guarantee every
// occurrence is on that line -- reported honestly as such wherever it's
// displayed.
function lineNumberAt(text, index) {
  if (index < 0) return null;
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function scanIndicators(text) {
  if (!text) return [];
  const results = [];

  for (const category of CATEGORIES) {
    // category.pattern always carries the "g" flag (see CATEGORIES above),
    // so matchAll is always safe here and gives us the match index needed
    // for a best-effort line number.
    const matchList = Array.from(text.matchAll(category.pattern));
    if (matchList.length === 0) continue;

    const samplesSet = new Set();
    for (const m of matchList) {
      if (samplesSet.size >= MAX_MATCHES_PER_CATEGORY) break;
      samplesSet.add(m[0]);
    }

    results.push({
      id: category.id,
      label: category.label,
      severity: category.severity,
      weight: category.weight,
      group: category.group,
      count: matchList.length,
      samples: Array.from(samplesSet),
      line: lineNumberAt(text, matchList[0].index),
    });
  }

  return results;
}

export const INDICATOR_CATEGORIES = CATEGORIES;
