import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge, Box, Code, DropdownMenu, Flex, Heading, IconButton, ScrollArea,
  Switch, Table, Tabs, Text, TextField, Theme, Tooltip,
} from '@radix-ui/themes'
import {
  ChevronDownIcon, ChevronRightIcon, CrossCircledIcon, DotsHorizontalIcon,
  MagnifyingGlassIcon, ReloadIcon,
} from '@radix-ui/react-icons'

interface ProcRow {
  pid: number; ppid: number; cpu: number; mem: number; rss: number
  user: string; etime: string; name: string; path: string
}
interface PortRow {
  pid: number; command: string; user: string; proto: string
  address: string; port: number
}
interface SysInfo { loadavg: number[]; ncpu: number; memBytes: number; win?: boolean }

// One app = every process sharing a name (all the node.exe processes), with
// the members' totals. Sorts with the same keys as a single process.
interface Group {
  key: string; name: string; procs: ProcRow[]
  pid: number; cpu: number; mem: number; rss: number
  user: string; etime: string // shared user ('' when mixed); oldest member's etime
}

type Dir = 1 | -1
interface Sort { key: string; dir: Dir }

const REFRESH_MS = 2500

// switch units at 1000, not 1024, so a cell never shows four digits ("1009 MB")
function fmtRss(kb: number): string {
  if (kb >= 1000 * 1024) return (kb / 1024 / 1024).toFixed(1) + ' GB'
  if (kb >= 1000) return (kb / 1024).toFixed(0) + ' MB'
  return kb + ' KB'
}

// Backends report %CPU of ONE core (ps convention, up to ncpu × 100), so
// cpu / 100 is cores in use and cpu / ncpu the share of the machine.

// Heat by share of the machine: amber from an eighth of it, red from a
// quarter — with floors of 1 and 2 whole cores so small machines don't light
// up. A few % of a big box is an ordinary morning, not a warning. 16 cores:
// amber 12.5%+ (200 per core), red 25%+ (400); 4 cores: amber 25%+ (100),
// red 50%+ (200).
function cpuColor(cpu: number, ncpu: number): 'red' | 'amber' | 'gray' {
  const cores = cpu / 100
  if (cores >= Math.max(2, ncpu / 4)) return 'red'
  return cores >= Math.max(1, ncpu / 8) ? 'amber' : 'gray'
}

// ps etime: [[dd-]hh:]mm:ss → seconds, so Elapsed sorts by duration, not text
function etimeSecs(s: string): number {
  const [days, clock] = s.includes('-') ? s.split('-') : ['0', s]
  return clock.split(':').reduce((acc, n) => acc * 60 + +n, 0) + +days * 86400
}

// "12d 12h" / "1h 23m" / "31m 20s" / "7s" — ps's "12-12:48:05" read as a date
function fmtElapsed(etime: string): string {
  if (!etime) return ''
  const s = etimeSecs(etime)
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60), sec = s % 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

function sortValue(row: unknown, key: string): unknown {
  const v = (row as Record<string, unknown>)[key === 'cores' ? 'cpu' : key]
  return key === 'etime' && typeof v === 'string' ? etimeSecs(v) : v
}

function sortBy<T>(rows: T[], sort: Sort): T[] {
  const { key, dir } = sort
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key)
    const bv = sortValue(b, key)
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
    return String(av).localeCompare(String(bv)) * dir
  })
}

function groupProcs(rows: ProcRow[], sort: Sort): Group[] {
  const byKey = new Map<string, ProcRow[]>()
  for (const p of rows) {
    const k = p.name.toLowerCase()
    const list = byKey.get(k)
    if (list) list.push(p)
    else byKey.set(k, [p])
  }
  const groups: Group[] = []
  for (const [key, list] of byKey) {
    let cpu = 0, mem = 0, rss = 0, pid = Infinity, oldest = list[0]
    for (const p of list) {
      cpu += p.cpu; mem += p.mem; rss += p.rss; pid = Math.min(pid, p.pid)
      if (etimeSecs(p.etime) > etimeSecs(oldest.etime)) oldest = p
    }
    const user = list.every((p) => p.user === list[0].user) ? list[0].user : ''
    groups.push({
      key, name: list[0].name, procs: sortBy(list, sort),
      pid, cpu, mem, rss, user, etime: oldest.etime,
    })
  }
  return sortBy(groups, sort)
}

function SortHeader({ label, k, sort, onSort, align }: {
  label: string; k: string; sort: Sort; onSort: (s: Sort) => void
  align?: 'right'
}) {
  const active = sort.key === k
  return (
    <Table.ColumnHeaderCell
      onClick={() => onSort({ key: k, dir: active ? (-sort.dir as Dir) : sort.dir })}
      style={{ cursor: 'pointer', userSelect: 'none', textAlign: align, whiteSpace: 'nowrap' }}
    >
      {label}{active ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
    </Table.ColumnHeaderCell>
  )
}

export default function App() {
  const [tab, setTab] = useState<'procs' | 'ports'>('procs')
  const [procs, setProcs] = useState<ProcRow[]>([])
  const [ports, setPorts] = useState<PortRow[]>([])
  const [sys, setSys] = useState<SysInfo | null>(null)
  const [filter, setFilter] = useState('')
  const [live, setLive] = useState(true)
  const [dark, setDark] = useState(false)
  const [procSort, setProcSort] = useState<Sort>({ key: 'cpu', dir: -1 })
  const [portSort, setPortSort] = useState<Sort>({ key: 'port', dir: 1 })
  const [grouped, setGrouped] = useState(true)
  const [open, setOpen] = useState<Set<string>>(() => new Set()) // expanded app keys

  useEffect(() => {
    tiny.store.get('groupByApp').then((v) => { if (typeof v === 'boolean') setGrouped(v) })
  }, [])
  const pickGrouped = (v: boolean) => {
    setGrouped(v)
    tiny.store.set('groupByApp', v)
  }
  const toggleOpen = (key: string) => setOpen((prev) => {
    const next = new Set(prev)
    if (!next.delete(key)) next.add(key)
    return next
  })

  // Only the visible tab is fetched (lsof / ps are the expensive spawns), and a
  // tick that lands while the previous refresh is still running is skipped
  // rather than queued behind it (per tab, so switching tabs loads at once).
  const busy = useRef({ procs: false, ports: false })
  const refresh = useCallback(async () => {
    if (busy.current[tab]) return
    busy.current[tab] = true
    try {
      const [rows, s] = await Promise.all([
        tiny.api.call(tab) as Promise<ProcRow[] | PortRow[]>,
        tiny.api.call('sysinfo') as Promise<SysInfo>,
      ])
      if (tab === 'procs') setProcs(rows as ProcRow[])
      else setPorts(rows as PortRow[])
      setSys(s)
    } catch (e) {
      tiny.log('refresh failed: ' + e)
    } finally {
      busy.current[tab] = false
    }
  }, [tab])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    if (!live) return
    const t = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(t)
  }, [live, refresh])

  useEffect(() => {
    tiny.theme.get().then((t) => { if (t) setDark(t.dark) })
    tiny.theme.on((d) => setDark(d))
  }, [])

  const win = !!sys?.win
  const ncpu = sys?.ncpu || 1

  const kill = useCallback(async (pid: number, name: string, force: boolean) => {
    const detail = win
      ? `PID ${pid} will be ${force ? 'force-terminated — unsaved data is lost.' : 'asked to close.'}`
      : `PID ${pid} will be sent ${force ? 'SIGKILL — unsaved data is lost.' : 'SIGTERM.'}`
    const ok = await tiny.win.confirm(
      force ? `Force kill “${name}”?` : `Quit “${name}”?`,
      {
        detail,
        ok: force ? 'Force Kill' : 'Quit Process',
        cancel: 'Cancel',
      },
    )
    if (!ok) return
    try {
      await tiny.api.call('kill', { pid, force })
    } catch (e) {
      await tiny.win.alert('Could not kill process', String(e))
    }
    refresh()
  }, [refresh, win])

  // Every process of an app, after one confirmation. Kills run one at a time;
  // failures (already gone, access denied) are summed up in a single alert.
  const killGroup = useCallback(async (g: Group, force: boolean) => {
    const n = g.procs.length
    const ok = await tiny.win.confirm(
      force ? `Force kill all ${n} “${g.name}” processes?` : `Quit all ${n} “${g.name}” processes?`,
      {
        detail: force ? 'Unsaved data in any of them is lost.' : 'Each one is asked to close.',
        ok: force ? 'Force Kill All' : 'Quit All',
        cancel: 'Cancel',
      },
    )
    if (!ok) return
    const errors: string[] = []
    for (const p of g.procs) {
      try { await tiny.api.call('kill', { pid: p.pid, force }) }
      catch (e) { errors.push(`PID ${p.pid}: ${e}`) }
    }
    if (errors.length) {
      await tiny.win.alert(`Could not kill ${errors.length} of ${n} processes`,
        errors.slice(0, 5).join('\n') + (errors.length > 5 ? '\n…' : ''))
    }
    refresh()
  }, [refresh])

  const q = filter.trim().toLowerCase()
  const shownProcs = useMemo(() => {
    const rows = q
      ? procs.filter((p) =>
          p.name.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) ||
          String(p.pid) === q)
      : procs
    return sortBy(rows, procSort)
  }, [procs, q, procSort])

  // filter first, then group: a group's totals cover the processes shown
  const groups = useMemo(() => groupProcs(shownProcs, procSort), [shownProcs, procSort])

  const shownPorts = useMemo(() => {
    const rows = q
      ? ports.filter((p) =>
          p.command.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) ||
          String(p.port).includes(q) || String(p.pid) === q)
      : ports
    return sortBy(rows, portSort)
  }, [ports, q, portSort])

  const memGb = sys ? (sys.memBytes / 1024 ** 3).toFixed(0) : '–'

  return (
    <Theme appearance={dark ? 'dark' : 'light'} accentColor="iris" grayColor="slate"
      radius="large" style={{ height: '100vh' }}>
      <Flex direction="column" height="100%">

        <Flex align="center" gap="4" px="4" py="3"
          style={{ borderBottom: '1px solid var(--gray-a5)', flexShrink: 0 }}>
          <Heading size="4">Procsy</Heading>
          <Tabs.Root value={tab} onValueChange={(v) => setTab(v as 'procs' | 'ports')}>
            <Tabs.List size="1">
              <Tabs.Trigger value="procs">Processes</Tabs.Trigger>
              <Tabs.Trigger value="ports">Open Ports</Tabs.Trigger>
            </Tabs.List>
          </Tabs.Root>
          <Box flexGrow="1" />
          <TextField.Root size="2" placeholder="Filter by name, user, pid, port…"
            value={filter} onChange={(e) => setFilter(e.target.value)}
            style={{ width: 240 }}>
            <TextField.Slot><MagnifyingGlassIcon /></TextField.Slot>
          </TextField.Root>
          {tab === 'procs' && (
            <Flex align="center" gap="2" title="One row per app, totalled; click it to see its processes">
              <Switch size="1" checked={grouped} onCheckedChange={pickGrouped} />
              <Text size="1" color="gray">Group</Text>
            </Flex>
          )}
          <Flex align="center" gap="2">
            <Switch size="1" checked={live} onCheckedChange={setLive} />
            <Text size="1" color="gray">Live</Text>
            <Tooltip content="Refresh now">
              <IconButton size="1" variant="soft" onClick={refresh}><ReloadIcon /></IconButton>
            </Tooltip>
          </Flex>
        </Flex>

        <ScrollArea style={{ flex: 1 }}>
          {tab === 'procs' ? (
            <Table.Root size="1">
              <Table.Header>
                <Table.Row>
                  <SortHeader label="PID" k="pid" sort={procSort} onSort={setProcSort} />
                  <SortHeader label="Name" k="name" sort={procSort} onSort={setProcSort} />
                  <SortHeader label="User" k="user" sort={procSort} onSort={setProcSort} />
                  <SortHeader label="Cores" k="cores" sort={procSort} onSort={setProcSort} align="right" />
                  <SortHeader label="CPU %" k="cpu" sort={procSort} onSort={setProcSort} align="right" />
                  <SortHeader label="Mem %" k="mem" sort={procSort} onSort={setProcSort} align="right" />
                  <SortHeader label="RSS" k="rss" sort={procSort} onSort={setProcSort} align="right" />
                  <SortHeader label="Elapsed" k="etime" sort={procSort} onSort={setProcSort} align="right" />
                  <Table.ColumnHeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {grouped
                  ? groups.map((g) => g.procs.length === 1
                    ? <ProcLine key={g.key} p={g.procs[0]} ncpu={ncpu} win={win} kill={kill} indent="leaf" />
                    : [
                        <GroupLine key={g.key} g={g} ncpu={ncpu} win={win} open={open.has(g.key)}
                          onToggle={() => toggleOpen(g.key)} killGroup={killGroup} />,
                        ...(open.has(g.key)
                          ? g.procs.map((p) => (
                              <ProcLine key={p.pid} p={p} ncpu={ncpu} win={win} kill={kill} indent="child" />
                            ))
                          : []),
                      ])
                  : shownProcs.map((p) => (
                      <ProcLine key={p.pid} p={p} ncpu={ncpu} win={win} kill={kill} />
                    ))}
              </Table.Body>
            </Table.Root>
          ) : (
            <Table.Root size="1">
              <Table.Header>
                <Table.Row>
                  <SortHeader label="Port" k="port" sort={portSort} onSort={setPortSort} />
                  <SortHeader label="Proto" k="proto" sort={portSort} onSort={setPortSort} />
                  <SortHeader label="Address" k="address" sort={portSort} onSort={setPortSort} />
                  <SortHeader label="Process" k="command" sort={portSort} onSort={setPortSort} />
                  <SortHeader label="PID" k="pid" sort={portSort} onSort={setPortSort} />
                  <SortHeader label="User" k="user" sort={portSort} onSort={setPortSort} />
                  <Table.ColumnHeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {shownPorts.map((p) => (
                  <Table.Row key={`${p.pid}:${p.proto}:${p.address}:${p.port}`} align="center">
                    <Table.RowHeaderCell><Code size="2">{p.port}</Code></Table.RowHeaderCell>
                    <Table.Cell>
                      <Badge size="1" variant="soft" color={p.proto === 'TCP' ? 'indigo' : 'orange'}>
                        {p.proto}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell><Text size="1" color="gray">{p.address}</Text></Table.Cell>
                    <Table.Cell><Text size="1">{p.command}</Text></Table.Cell>
                    <Table.Cell><Code size="1" variant="ghost">{p.pid || '–'}</Code></Table.Cell>
                    <Table.Cell><Text size="1" color="gray">{p.user}</Text></Table.Cell>
                    <Table.Cell>
                      {/* pid 0: owner not visible without root (Linux ss) */}
                      {p.pid > 0 && <Tooltip content="Kill this process">
                        <IconButton size="1" variant="ghost" color="red"
                          onClick={() => kill(p.pid, p.command, false)}>
                          <CrossCircledIcon />
                        </IconButton>
                      </Tooltip>}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </ScrollArea>

        <Flex align="center" gap="3" px="4" py="2"
          style={{ borderTop: '1px solid var(--gray-a5)', flexShrink: 0 }}>
          <Text size="1" color="gray">
            {tab === 'procs'
              ? (grouped ? `${groups.length} apps · ` : '') + `${shownProcs.length} of ${procs.length} processes`
              : `${shownPorts.length} of ${ports.length} open ports`}
          </Text>
          <Box flexGrow="1" />
          {sys && (
            <Text size="1" color="gray">
              {sys.win
                ? `cpu ${(sys.loadavg[0] ?? 0).toFixed(0)}%`
                : `load ${sys.loadavg.map((n) => n.toFixed(2)).join(' · ')}`}
              {'  —  '}{sys.ncpu} cores · {memGb} GB RAM
            </Text>
          )}
        </Flex>

      </Flex>
    </Theme>
  )
}

// Cores in use and share of the machine, side by side; heat on the share.
function CpuCells({ cpu, ncpu }: { cpu: number; ncpu: number }) {
  return (
    <>
      <Table.Cell className="num"><Text size="1">{(cpu / 100).toFixed(2)}</Text></Table.Cell>
      <Table.Cell className="num">
        <Badge size="1" color={cpuColor(cpu, ncpu)} variant="soft">{(cpu / ncpu).toFixed(1)}</Badge>
      </Table.Cell>
    </>
  )
}

// indent: 'leaf' = a single-process app in the grouped view (its name lines up
// with group names past the chevron); 'child' = a process under an open app.
function ProcLine({ p, ncpu, win, kill, indent }: {
  p: ProcRow; ncpu: number; win: boolean
  kill: (pid: number, name: string, force: boolean) => void
  indent?: 'leaf' | 'child'
}) {
  return (
    <Table.Row align="center" className={indent === 'child' ? 'proc-child' : undefined}>
      <Table.Cell><Code size="1" variant="ghost">{p.pid}</Code></Table.Cell>
      <Table.RowHeaderCell>
        {/* 19px = the group row's 15px chevron + 4px gap */}
        <Box style={{ paddingLeft: indent === 'child' ? 32 : indent === 'leaf' ? 19 : 0 }}>
          <Tooltip content={p.path || p.name}><Text size="1" className="clip">{p.name}</Text></Tooltip>
        </Box>
      </Table.RowHeaderCell>
      <Table.Cell><Text size="1" color="gray">{p.user}</Text></Table.Cell>
      <CpuCells cpu={p.cpu} ncpu={ncpu} />
      <Table.Cell className="num"><Text size="1">{p.mem.toFixed(1)}</Text></Table.Cell>
      <Table.Cell className="num"><Text size="1">{fmtRss(p.rss)}</Text></Table.Cell>
      <Table.Cell className="num"><Text size="1" color="gray">{fmtElapsed(p.etime)}</Text></Table.Cell>
      <Table.Cell>
        <RowMenu
          win={win}
          onQuit={() => kill(p.pid, p.name, false)}
          onKill={() => kill(p.pid, p.name, true)}
          copies={[['Copy PID', String(p.pid)], ['Copy Path', p.path]]}
        />
      </Table.Cell>
    </Table.Row>
  )
}

function GroupLine({ g, ncpu, win, open, onToggle, killGroup }: {
  g: Group; ncpu: number; win: boolean; open: boolean; onToggle: () => void
  killGroup: (g: Group, force: boolean) => void
}) {
  const n = g.procs.length
  const path = g.procs.find((p) => p.path)?.path ?? ''
  return (
    <Table.Row align="center" className="proc-group" onClick={onToggle}>
      <Table.Cell />
      <Table.RowHeaderCell>
        <Flex align="center" gap="1">
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          <Text size="1" weight="medium" className="clip">{g.name}</Text>
          <Text size="1" color="gray">({n})</Text>
        </Flex>
      </Table.RowHeaderCell>
      <Table.Cell><Text size="1" color="gray">{g.user || '—'}</Text></Table.Cell>
      <CpuCells cpu={g.cpu} ncpu={ncpu} />
      <Table.Cell className="num"><Text size="1">{g.mem.toFixed(1)}</Text></Table.Cell>
      <Table.Cell className="num"><Text size="1">{fmtRss(g.rss)}</Text></Table.Cell>
      <Table.Cell className="num" title="longest-running process">
        <Text size="1" color="gray">{fmtElapsed(g.etime)}</Text>
      </Table.Cell>
      {/* the menu must not also expand/collapse the row */}
      <Table.Cell onClick={(e) => e.stopPropagation()}>
        <RowMenu
          win={win}
          quitLabel={`Quit All (${n})`}
          killLabel={`Force Kill All (${n})`}
          onQuit={() => killGroup(g, false)}
          onKill={() => killGroup(g, true)}
          copies={[['Copy PIDs', g.procs.map((p) => p.pid).join(' ')], ['Copy Path', path]]}
        />
      </Table.Cell>
    </Table.Row>
  )
}

function RowMenu({ win, onQuit, onKill, copies, quitLabel, killLabel }: {
  win: boolean; onQuit: () => void; onKill: () => void; copies: [string, string][]
  quitLabel?: string; killLabel?: string
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <IconButton size="1" variant="ghost"><DotsHorizontalIcon /></IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content size="1">
        <DropdownMenu.Item onSelect={onQuit}>{quitLabel ?? (win ? 'Quit' : 'Quit (SIGTERM)')}</DropdownMenu.Item>
        <DropdownMenu.Item color="red" onSelect={onKill}>{killLabel ?? (win ? 'Force Kill' : 'Force Kill (SIGKILL)')}</DropdownMenu.Item>
        <DropdownMenu.Separator />
        {copies.map(([label, value]) => (
          <DropdownMenu.Item key={label} onSelect={() => navigator.clipboard.writeText(value)}>
            {label}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  )
}
