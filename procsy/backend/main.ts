// procsy backend — shells out to ps/lsof (macOS), ps/ss + /proc (Linux) or
// PowerShell (Windows) and exposes the results as api calls.
const dec = new TextDecoder();

// txiki has no tjs.platform — key everything off the OS env var.
const IS_WIN = tjs.env.OS === 'Windows_NT';
const IS_LINUX = !IS_WIN && /linux/i.test(globalThis.navigator?.platform ?? '');

// procsy.exe is a GUI-subsystem exe, so on Windows every console child
// (powershell, taskkill) gets a visible console of its own — a Windows
// Terminal window on 11. app.spawnHidden (tinyjs 0.28.2+) routes it through
// `launcher --run` (CREATE_NO_WINDOW, stdio passed through); elsewhere it is
// plain tjs.spawn. init() swaps it in before any api call can run.
type SpawnFn = (args: string[], opts: object) => any;
let spawn: SpawnFn = (args, opts) => tjs.spawn(args, opts);

const enc = new TextEncoder();

function parseJsonRows(out: string): any[] {
  const t = out.trim();
  if (!t) return [];
  const data = JSON.parse(t);
  return Array.isArray(data) ? data : [data];
}

// ── Windows PowerShell worker ──────────────────────────────────────────────
// One cold PowerShell spawn per api call (~1s startup) was hammering the box
// every refresh. Instead we run ONE long-lived PowerShell process, spawned
// lazily on the first Windows call and reused. It loops on stdin: 'p' → process
// table, 'n' → listening ports, 's' → sysinfo — one compact JSON line each;
// 'q'/EOF exits. Being persistent lets it compute %CPU from Kernel+User time
// deltas and cache what never changes (paths, owners, RAM).
//
// The data comes from WORKER_CS, a small C# class the worker compiles with
// Add-Type at startup (~0.3s): NtQuerySystemInformation and
// GetExtended{Tcp,Udp}Table, what Task Manager and netstat use — ~50ms a
// sweep. The WMI route (Get-CimInstance Win32_Process, Get-NetTCPConnection)
// took ~1.1s each and kept WmiPrvSE busy. The C# is too long for the 32K
// command line, so the worker reads it from stdin up to a //END line. Where
// Add-Type is blocked (Constrained Language Mode under AppLocker/WDAC) the
// worker falls back to the WMI script below.
// Keep WORKER_CS pure ASCII: it crosses stdin in the console's OEM codepage.
const WORKER_CS = String.raw`using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class Procsy {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder sb, ref int size);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr h, int access, out IntPtr tok);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr tok, int cls, IntPtr buf, int len, out int ret);
  [DllImport("iphlpapi.dll")] static extern int GetExtendedTcpTable(IntPtr buf, ref int size, bool sort, int af, int cls, int reserved);
  [DllImport("iphlpapi.dll")] static extern int GetExtendedUdpTable(IntPtr buf, ref int size, bool sort, int af, int cls, int reserved);
  [StructLayout(LayoutKind.Sequential)] class MemStatus { public int len = 64, load; public ulong total, avail, tp, ap, tv, av, ae; }
  [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx([In, Out] MemStatus m);

  class Info { public long create; public string path = "", user = ""; }
  static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
  static readonly Dictionary<int, long[]> prev = new Dictionary<int, long[]>(); // pid -> {create, cpu ticks}
  static readonly Dictionary<int, Info> infos = new Dictionary<int, Info>();
  static readonly Dictionary<string, string> accounts = new Dictionary<string, string>();
  static long prevStamp;
  static double overall;
  static ulong totalMem;

  public static ulong TotalMem() {
    if (totalMem == 0) { var m = new MemStatus(); if (GlobalMemoryStatusEx(m)) totalMem = m.total; }
    return totalMem;
  }

  // SystemProcessInformation (5): every process with times, ppid and working set,
  // readable without elevation (what Task Manager uses). Offsets are x64.
  delegate void Visit(IntPtr e, int pid);
  static void Walk(Visit visit) {
    if (IntPtr.Size != 8) throw new PlatformNotSupportedException(); // -> WMI fallback
    int len = 1 << 20;
    while (true) {
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        int ret, st = NtQuerySystemInformation(5, buf, len, out ret);
        if (st == unchecked((int)0xC0000004)) { len = Math.Max(len * 2, ret + 65536); continue; }
        if (st != 0) throw new Exception("NtQuerySystemInformation 0x" + st.ToString("x8"));
        for (long off = 0; ; ) {
          IntPtr e = new IntPtr(buf.ToInt64() + off);
          visit(e, (int)Marshal.ReadIntPtr(e, 80).ToInt64());
          int next = Marshal.ReadInt32(e, 0);
          if (next == 0) break;
          off += next;
        }
        return;
      } finally { Marshal.FreeHGlobal(buf); }
    }
  }

  static string ImageName(IntPtr e, int pid) {
    IntPtr p = Marshal.ReadIntPtr(e, 64);
    if (p == IntPtr.Zero) return pid == 4 ? "System" : "";
    return Marshal.PtrToStringUni(p, Marshal.ReadInt16(e, 56) / 2);
  }

  // path + owner, looked up once per process (pid + creation time)
  static Info Lookup(int pid, long create) {
    Info inf;
    if (infos.TryGetValue(pid, out inf) && inf.create == create) return inf;
    inf = new Info { create = create };
    infos[pid] = inf;
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return inf;
    try {
      var sb = new StringBuilder(1024); int size = sb.Capacity;
      if (QueryFullProcessImageName(h, 0, sb, ref size)) inf.path = sb.ToString(0, size);
      IntPtr tok;
      if (OpenProcessToken(h, 8, out tok)) { // TOKEN_QUERY
        IntPtr tb = Marshal.AllocHGlobal(256);
        try {
          int ret;
          if (GetTokenInformation(tok, 1, tb, 256, out ret)) inf.user = Account(new SecurityIdentifier(Marshal.ReadIntPtr(tb)));
        } finally { Marshal.FreeHGlobal(tb); CloseHandle(tok); }
      }
    } catch { } finally { CloseHandle(h); }
    return inf;
  }

  static string Account(SecurityIdentifier sid) {
    string key = sid.Value, name;
    if (accounts.TryGetValue(key, out name)) return name;
    try { name = ((NTAccount)sid.Translate(typeof(NTAccount))).Value; } catch { name = key; }
    int i = name.IndexOf('\\');
    return accounts[key] = i >= 0 ? name.Substring(i + 1) : name;
  }

  static string Etime(long ticks) {
    var t = TimeSpan.FromTicks(Math.Max(0, ticks));
    if (t.Days > 0) return string.Format(Inv, "{0}-{1:00}:{2:00}:{3:00}", t.Days, t.Hours, t.Minutes, t.Seconds);
    if (t.Hours > 0) return string.Format(Inv, "{0}:{1:00}:{2:00}", t.Hours, t.Minutes, t.Seconds);
    return string.Format(Inv, "{0:00}:{1:00}", t.Minutes, t.Seconds);
  }

  static void Str(StringBuilder sb, string s) {
    sb.Append('"');
    foreach (char c in s) {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    sb.Append('"');
  }

  // %CPU is per process of ONE core (like ps), from Kernel+User time deltas
  // between calls; the overall figure is the same sum spread over all cores.
  public static string Procs() {
    long now = DateTime.UtcNow.ToFileTimeUtc(); // 100 ns since 1601, as CreateTime
    double elapsed = prevStamp > 0 ? now - prevStamp : 0, sum = 0, total = TotalMem();
    var seen = new HashSet<int>();
    var sb = new StringBuilder("[");
    Walk((e, pid) => {
      if (pid == 0) return; // System Idle Process would read as ~100% busy
      long create = Marshal.ReadInt64(e, 32);
      long ticks = Marshal.ReadInt64(e, 40) + Marshal.ReadInt64(e, 48);
      double cpu = 0;
      long[] p;
      if (elapsed > 0 && prev.TryGetValue(pid, out p) && p[0] == create && ticks > p[1]) {
        sum += ticks - p[1];
        cpu = Math.Round((ticks - p[1]) / elapsed * 100, 1);
      }
      prev[pid] = new long[] { create, ticks };
      seen.Add(pid);
      long ws = Marshal.ReadIntPtr(e, 144).ToInt64();
      Info inf = Lookup(pid, create);
      if (sb.Length > 1) sb.Append(',');
      sb.Append("{\"pid\":").Append(pid)
        .Append(",\"ppid\":").Append(Marshal.ReadIntPtr(e, 88).ToInt64())
        .Append(",\"cpu\":").Append(cpu.ToString(Inv))
        .Append(",\"mem\":").Append((total > 0 ? Math.Round(ws * 100.0 / total, 1) : 0).ToString(Inv))
        .Append(",\"rss\":").Append(ws / 1024)
        .Append(",\"user\":"); Str(sb, inf.user);
      sb.Append(",\"etime\":"); Str(sb, create > 0 ? Etime(now - create) : "");
      sb.Append(",\"name\":"); Str(sb, ImageName(e, pid));
      sb.Append(",\"path\":"); Str(sb, inf.path);
      sb.Append('}');
    });
    if (elapsed > 0) overall = Math.Round(sum / elapsed / Environment.ProcessorCount * 100, 1);
    prevStamp = now;
    foreach (var pid in new List<int>(prev.Keys)) if (!seen.Contains(pid)) { prev.Remove(pid); infos.Remove(pid); }
    return sb.Append(']').ToString();
  }

  public static string Sys() {
    return "{\"memBytes\":" + TotalMem() + ",\"ncpu\":" + Environment.ProcessorCount + ",\"cpu\":" + overall.ToString(Inv) + "}";
  }

  // Listening TCP + bound UDP sockets with owning pid, v4 and v6 (the backend
  // dedupes).
  delegate int Table(IntPtr buf, ref int size, bool sort, int af, int cls, int reserved);
  static void Rows(Table fn, int af, int cls, int rowSize, Action<IntPtr> row) {
    int size = 0;
    fn(IntPtr.Zero, ref size, false, af, cls, 0);
    for (int tries = 0; tries < 4; tries++) {
      IntPtr buf = Marshal.AllocHGlobal(size += 4096);
      try {
        int st = fn(buf, ref size, false, af, cls, 0);
        if (st == 122) continue; // ERROR_INSUFFICIENT_BUFFER: table grew
        if (st != 0) return;
        int n = Marshal.ReadInt32(buf);
        for (int i = 0; i < n; i++) row(new IntPtr(buf.ToInt64() + 4 + (long)i * rowSize));
        return;
      } finally { Marshal.FreeHGlobal(buf); }
    }
  }

  static int Port(IntPtr r, int off) { int v = Marshal.ReadInt32(r, off); return ((v & 0xff) << 8) | ((v >> 8) & 0xff); }
  static string V4(IntPtr r, int off) { return new IPAddress((long)(uint)Marshal.ReadInt32(r, off)).ToString(); }
  static string V6(IntPtr r, int off) { var b = new byte[16]; Marshal.Copy(new IntPtr(r.ToInt64() + off), b, 0, 16); return new IPAddress(b).ToString(); }

  public static string Ports() {
    var names = new Dictionary<int, string>();
    Walk((e, pid) => {
      string n = ImageName(e, pid);
      names[pid] = n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? n.Substring(0, n.Length - 4) : n;
    });
    var sb = new StringBuilder("[");
    Action<string, string, int, int> add = (proto, addr, port, pid) => {
      string name;
      names.TryGetValue(pid, out name);
      if (sb.Length > 1) sb.Append(',');
      sb.Append("{\"pid\":").Append(pid).Append(",\"command\":"); Str(sb, name ?? "");
      sb.Append(",\"user\":\"\",\"proto\":\"").Append(proto).Append("\",\"address\":"); Str(sb, addr);
      sb.Append(",\"port\":").Append(port).Append('}');
    };
    // TCP_TABLE_OWNER_PID_LISTENER = 3, UDP_TABLE_OWNER_PID = 1
    Rows(GetExtendedTcpTable, 2, 3, 24, r => add("TCP", V4(r, 4), Port(r, 8), Marshal.ReadInt32(r, 20)));
    Rows(GetExtendedTcpTable, 23, 3, 56, r => add("TCP", V6(r, 0), Port(r, 20), Marshal.ReadInt32(r, 52)));
    Rows(GetExtendedUdpTable, 2, 1, 12, r => add("UDP", V4(r, 0), Port(r, 4), Marshal.ReadInt32(r, 8)));
    Rows(GetExtendedUdpTable, 23, 1, 28, r => add("UDP", V6(r, 0), Port(r, 20), Marshal.ReadInt32(r, 24)));
    return sb.Append(']').ToString();
  }
}
`;

const WORKER_SCRIPT = [
  "$ProgressPreference='SilentlyContinue'",
  "$ErrorActionPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
  "$src=New-Object System.Text.StringBuilder",
  "while($true){$l=[Console]::In.ReadLine();if($null -eq $l -or $l -eq '//END'){break};[void]$src.AppendLine($l)}",
  // compile, then prime one sample so the first 'p' already has CPU deltas
  "$native=$false;try{Add-Type -TypeDefinition $src.ToString() -ErrorAction Stop;[void][Procsy]::Procs();$native=$true}catch{}",
  "function Out1($j){[Console]::Out.WriteLine($j);[Console]::Out.Flush()}",
  "$prev=@{}",                 // pid -> previous (kernel+user) 100ns ticks
  "$prevT=$null",              // timestamp of previous 'p' sample
  "$total=$null",              // cached total physical memory (bytes)
  "$ncpu=[double]$env:NUMBER_OF_PROCESSORS",
  "$lastOverall=0.0",          // overall CPU% from the last 'p' sample
  "function Emit($o){if($null -eq $o){[Console]::Out.WriteLine('[]');[Console]::Out.Flush();return};$j=ConvertTo-Json -Compress -Depth 3 -InputObject $o;if([string]::IsNullOrEmpty($j)){$j='[]'};[Console]::Out.WriteLine($j);[Console]::Out.Flush()}",
  "while($true){",
  "$line=[Console]::In.ReadLine()",
  "if($null -eq $line){break}",
  "$cmd=$line.Trim()",
  "if($cmd -eq 'q'){break}",
  "elseif($native -and $cmd -eq 'p'){Out1 ([Procsy]::Procs())}",
  "elseif($native -and $cmd -eq 'n'){Out1 ([Procsy]::Ports())}",
  "elseif($native -and $cmd -eq 's'){Out1 ([Procsy]::Sys())}",
  // WMI fallback: only reached when Add-Type failed
  "elseif($cmd -eq 'p'){",
  "if($null -eq $total){$total=[double](Get-CimInstance Win32_ComputerSystem -Property TotalPhysicalMemory).TotalPhysicalMemory}",
  "$now=[DateTime]::Now",
  "$elapsed=0.0;if($prevT){$elapsed=($now-$prevT).TotalSeconds}",
  "$cur=@{}",
  "$sum=0.0",
  "$rows=Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,Name,ExecutablePath,CreationDate,KernelModeTime,UserModeTime|ForEach-Object{",
  "$id=[int]$_.ProcessId",
  "if($id -eq 0){return}",     // skip System Idle Process (would read as ~100% busy)
  "$ticks=[double]$_.KernelModeTime+[double]$_.UserModeTime",
  "$cur[$id]=$ticks",
  "$cpu=0.0",
  "if($elapsed -gt 0 -and $prev.ContainsKey($id)){$dt=$ticks-$prev[$id];if($dt -gt 0){$sum+=$dt;$cpu=[math]::Round($dt/1e7/$elapsed*100,1)}}",
  "$ws=[double]$_.WorkingSetSize",
  "$mem=0.0;if($total -gt 0){$mem=[math]::Round($ws/$total*100,1)}",
  "$et=''",
  "if($_.CreationDate){$sp=$now-$_.CreationDate;$dd=$sp.Days;$h=$sp.Hours;$m=$sp.Minutes;$s=$sp.Seconds;if($dd -gt 0){$et='{0}-{1:00}:{2:00}:{3:00}'-f$dd,$h,$m,$s}elseif($h -gt 0){$et='{0}:{1:00}:{2:00}'-f$h,$m,$s}else{$et='{0:00}:{1:00}'-f$m,$s}}",
  "$path='';if($_.ExecutablePath){$path=$_.ExecutablePath}",
  "[pscustomobject]@{pid=$id;ppid=[int]$_.ParentProcessId;cpu=$cpu;mem=$mem;rss=[long]($ws/1024);user='';etime=$et;name=$_.Name;path=$path}",
  "}",
  "if($elapsed -gt 0 -and $ncpu -gt 0){$lastOverall=[math]::Round($sum/1e7/$elapsed/$ncpu*100,1)}",
  "$prev=$cur;$prevT=$now",
  "Emit @($rows)",
  "}",
  "elseif($cmd -eq 'n'){",
  "$names=@{};Get-Process|ForEach-Object{$names[$_.Id]=$_.ProcessName}",
  "$rows=Get-NetTCPConnection -State Listen|ForEach-Object{$op=[int]$_.OwningProcess;$c='';if($names.ContainsKey($op)){$c=$names[$op]};[pscustomobject]@{pid=$op;command=$c;user='';proto='TCP';address=[string]$_.LocalAddress;port=[int]$_.LocalPort}}",
  "Emit @($rows)",
  "}",
  "elseif($cmd -eq 's'){",
  "if($null -eq $total){$total=[double](Get-CimInstance Win32_ComputerSystem -Property TotalPhysicalMemory).TotalPhysicalMemory}",
  "Emit ([pscustomobject]@{memBytes=[long]$total;ncpu=[int]$ncpu;cpu=[double]$lastOverall})",
  "}",
  "}",
].join('\n');

interface Worker { proc: any; reader: any; writer: any; buf: string; dead: boolean }
let worker: Worker | null = null;
let queue: Promise<unknown> = Promise.resolve();

function spawnWorker(): Worker {
  const proc = spawn(
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', WORKER_SCRIPT],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' },
  );
  const writer = proc.stdin.getWriter();
  // queued ahead of the first command; a dead worker surfaces in exchange()
  writer.write(enc.encode(WORKER_CS + '\n//END\n')).catch(() => {});
  return { proc, reader: proc.stdout.getReader(), writer, buf: '', dead: false };
}

// Read exactly one '\n'-terminated line, buffering any trailing bytes for the
// next call. Empty return + dead flag means the worker's stdout closed (death).
async function readLine(w: Worker): Promise<string> {
  let nl = w.buf.indexOf('\n');
  while (nl < 0) {
    const { value, done } = await w.reader.read();
    if (done) { w.dead = true; const rest = w.buf; w.buf = ''; return rest; }
    w.buf += dec.decode(value);
    nl = w.buf.indexOf('\n');
  }
  const line = w.buf.slice(0, nl).replace(/\r$/, '');
  w.buf = w.buf.slice(nl + 1);
  return line;
}

// Serialize every exchange (write command, read one line) through a promise
// chain so concurrent refresh calls can't interleave on the shared pipe. The
// chain keeps running even if one exchange rejects. Respawn once on death.
function ask(cmd: 'p' | 'n' | 's'): Promise<string> {
  const result = queue.then(() => exchange(cmd, true));
  queue = result.catch(() => undefined);
  return result;
}

async function exchange(cmd: string, retry: boolean): Promise<string> {
  if (!worker || worker.dead) worker = spawnWorker();
  try {
    await worker.writer.write(enc.encode(cmd + '\n'));
    const line = await readLine(worker);
    if (!line && worker.dead) throw new Error('worker exited');
    return line;
  } catch (e) {
    if (worker) {
      worker.dead = true;
      try { worker.proc.kill(); } catch { /* already gone */ }
    }
    worker = null;
    if (retry) return exchange(cmd, false);
    throw e;
  }
}

async function run(args: string[]): Promise<string> {
  const proc = spawn(args, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
  let out = '';
  const reader = proc.stdout.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
  } catch { /* stream closes with the process */ }
  await proc.wait();
  return out;
}

export interface ProcRow {
  pid: number;
  ppid: number;
  cpu: number;
  mem: number;
  rss: number; // KB
  user: string;
  etime: string;
  name: string;
  path: string;
}

export interface PortRow {
  pid: number;
  command: string;
  user: string;
  proto: string;
  address: string;
  port: number;
}

// one row per pid+proto+port+address (lsof / Get-NetTCPConnection repeat rows
// for IPv4/IPv6 and for every fd sharing a socket)
function dedupePorts(rows: PortRow[]): PortRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.pid}:${r.proto}:${r.port}:${r.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Windows: the persistent worker computes %CPU from Kernel+User time deltas
// (see WORKER_CS). user and path are looked up once per process and cached;
// both stay '' for protected system processes unless procsy runs elevated.
// etime is formatted worker-side to match macOS `ps` (mm:ss / h:mm:ss / d-hh:mm:ss).
async function listProcsWin(): Promise<ProcRow[]> {
  const out = await ask('p');
  return parseJsonRows(out).map((r): ProcRow => ({
    pid: +r.pid, ppid: +r.ppid, cpu: +r.cpu, mem: +r.mem, rss: +r.rss,
    user: r.user ?? '', etime: r.etime ?? '',
    name: r.name ?? '', path: r.path ?? '',
  }));
}

async function listProcs(): Promise<ProcRow[]> {
  if (IS_WIN) return listProcsWin();
  const out = await run(['/bin/ps', 'axo', 'pid=,ppid=,pcpu=,pmem=,rss=,user=,etime=,comm=']);
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const path = m[8].trim();
    rows.push({
      pid: +m[1], ppid: +m[2], cpu: +m[3], mem: +m[4], rss: +m[5],
      user: m[6], etime: m[7],
      name: path.split('/').pop() || path,
      path,
    });
  }
  return rows;
}

// Windows: listening TCP + bound UDP sockets with their owning pid, from the
// persistent worker (command 'n'; the WMI fallback reports TCP only). user is ''.
async function listPortsWin(): Promise<PortRow[]> {
  const out = await ask('n');
  return dedupePorts(parseJsonRows(out).map((r): PortRow => ({
    pid: +r.pid, command: r.command ?? '', user: r.user ?? '',
    proto: r.proto ?? 'TCP', address: r.address ?? '', port: +r.port,
  })));
}

// Linux: `ss` (iproute2 — always installed, unlike lsof). -H no header,
// -l listening (for UDP: bound), -n numeric, -t/-u tcp+udp, -p owning process.
// Line: `tcp LISTEN 0 4096 127.0.0.1:631 0.0.0.0:* users:(("cupsd",pid=812,fd=7))`
// Sockets owned by other users come back without users:(...) unless root —
// those rows keep pid 0 (the frontend hides the kill button for them).
function parseSs(out: string): PortRow[] {
  const rows: PortRow[] = [];
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0].toUpperCase();
    if (proto !== 'TCP' && proto !== 'UDP') continue;
    const local = cols[4];
    const i = local.lastIndexOf(':');
    const port = +local.slice(i + 1);
    if (i < 0 || !Number.isFinite(port)) continue;
    const address = local.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const procs = [...line.matchAll(/\("([^"]*)",pid=(\d+)/g)];
    if (!procs.length) rows.push({ pid: 0, command: '', user: '', proto, address, port });
    for (const [, command, pid] of procs) rows.push({ pid: +pid, command, user: '', proto, address, port });
  }
  return dedupePorts(rows);
}

async function listPorts(): Promise<PortRow[]> {
  if (IS_WIN) return listPortsWin();
  if (IS_LINUX) return parseSs(await run(['ss', '-Hlntup']));
  // lsof field mode (-F): p=pid, c=command, L=user, P=protocol, n=address.
  // -sTCP:LISTEN keeps only listening TCP sockets (UDP has no state and passes through).
  const out = await run(['/usr/sbin/lsof', '-nP', '-i', '-sTCP:LISTEN', '-FpcLPn']);
  const rows: PortRow[] = [];
  let pid = 0, command = '', user = '', proto = '';
  for (const line of out.split('\n')) {
    const tag = line[0], val = line.slice(1);
    if (tag === 'p') pid = +val;
    else if (tag === 'c') command = val;
    else if (tag === 'L') user = val;
    else if (tag === 'P') proto = val;
    else if (tag === 'n') {
      const i = val.lastIndexOf(':');
      const port = i >= 0 ? +val.slice(i + 1) : NaN;
      if (!Number.isFinite(port)) continue;
      rows.push({ pid, command, user, proto, address: i >= 0 ? val.slice(0, i) : val, port });
    }
  }
  return dedupePorts(rows);
}

export const api: Record<string, TinyApiHandler> = {
  procs: async () => listProcs(),
  ports: async () => listPorts(),

  kill: async ({ pid, force }: { pid: number; force?: boolean }) => {
    if (!Number.isInteger(pid) || pid <= 1) throw new Error('bad pid');
    // Windows: taskkill (add /F to force). taskkill without /F fails for
    // windowless processes — let that error surface like the mac branch does.
    const killArgs = IS_WIN
      ? ['taskkill', '/PID', String(pid), ...(force ? ['/F'] : [])]
      : ['/bin/kill', force ? '-9' : '-15', String(pid)];
    const proc = spawn(killArgs, {
      stdout: 'ignore', stderr: 'pipe', stdin: 'ignore',
    });
    let err = '';
    const reader = proc.stderr.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        err += dec.decode(value);
      }
    } catch { /* closed */ }
    const status = await proc.wait();
    if (status.exit_status !== 0) throw new Error(err.trim() || `kill exited ${status.exit_status}`);
    return true;
  },

  sysinfo: async () => {
    if (IS_WIN) {
      // Windows has no load average — report overall CPU % instead, and flag it
      // so the frontend labels it "cpu" rather than "load". The worker returns
      // cached memBytes/ncpu plus the overall CPU% from its last process sample.
      const out = await ask('s');
      let memBytes = 0, ncpu = 0, cpu = 0;
      try {
        const j = JSON.parse(out || '{}');
        memBytes = +j.memBytes || 0;
        ncpu = +j.ncpu || 0;
        cpu = +j.cpu || 0;
      } catch { /* leave zeros */ }
      return {
        loadavg: [cpu],
        ncpu: ncpu || (+tjs.env.NUMBER_OF_PROCESSORS || 0),
        memBytes,
        win: true,
      };
    }
    if (IS_LINUX) {
      // /proc/loadavg: "0.76 0.49 0.32 1/966 1071916"; /proc/meminfo: "MemTotal: 65791600 kB".
      // Core count and RAM never change — read them once.
      if (!linuxHw) {
        const [meminfo, cpuinfo] = await Promise.all([readText('/proc/meminfo'), readText('/proc/cpuinfo')]);
        const memKb = meminfo.match(/^MemTotal:\s+(\d+)/m);
        linuxHw = {
          ncpu: (cpuinfo.match(/^processor\s*:/gm) ?? []).length,
          memBytes: memKb ? +memKb[1] * 1024 : 0,
        };
      }
      return { loadavg: parseLoad(await readText('/proc/loadavg')), ...linuxHw };
    }
    // one sysctl spawn: loadavg ("{ 1.85 2.06 2.44 }"), then ncpu, then memsize
    const [load = '', ncpu = '', memsize = ''] =
      (await run(['/usr/sbin/sysctl', '-n', 'vm.loadavg', 'hw.ncpu', 'hw.memsize'])).split('\n');
    return {
      loadavg: parseLoad(load),
      ncpu: +ncpu || 0,
      memBytes: +memsize || 0,
    };
  },
};

function parseLoad(s: string): number[] {
  const m = s.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

let linuxHw: { ncpu: number; memBytes: number } | null = null;

// /proc files stat as 0 bytes; fall back to cat should readFile trust that size.
async function readText(path: string): Promise<string> {
  try {
    const s = dec.decode(await tjs.readFile(path));
    if (s) return s;
  } catch { /* fall through */ }
  return run(['cat', path]);
}

export function init(app: TinyApp & { spawnHidden?: SpawnFn }) {
  if (app.spawnHidden) spawn = (args, opts) => app.spawnHidden!(args, opts);
  app.setMenu([{ title: 'Help', items: [{ id: 'check-updates', label: 'Check for Updates…' }] }]);
}


export function onMenu(id: string, app: any) {
  if (id === 'check-updates') checkForUpdates(app);
}


// ── self-update (uniform across the examples) ──────────────────────────────
// The runtime does the real work (sha256 + signature verified, swap +
// relaunch). "Check for Updates…" runs this; the daily background check
// just taps you on the shoulder via a notification.
async function checkForUpdates(app: any) {
  try {
    const r = await app.update.check();
    if (r && r.available) {
      app.notify('Updating…', 'v' + r.latest + ' is downloading — the app will relaunch.');
      await app.update.install();
    } else {
      app.notify("You're up to date", 'v' + ((r && r.current) || '') + ' is the latest.');
    }
  } catch (e: any) {
    app.notify('Update check failed', String((e && e.message) || e));
  }
}

export function onUpdateAvailable(info: any, app: any) {
  app.notify('Update available', 'v' + info.latest + ' is ready — use "Check for Updates…" to install.');
}
