import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge, Box, Code, DropdownMenu, Flex, Heading, IconButton, ScrollArea,
  SegmentedControl, Switch, Table, Tabs, Text, TextField, Theme, Tooltip,
} from '@radix-ui/themes'
import {
  CrossCircledIcon, DotsHorizontalIcon, MagnifyingGlassIcon, ReloadIcon,
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

type Dir = 1 | -1
interface Sort { key: string; dir: Dir }

const REFRESH_MS = 2500

// switch units at 1000, not 1024, so a cell never shows four digits ("1009 MB")
function fmtRss(kb: number): string {
  if (kb >= 1000 * 1024) return (kb / 1024 / 1024).toFixed(1) + ' GB'
  if (kb >= 1000) return (kb / 1024).toFixed(0) + ' MB'
  return kb + ' KB'
}

// Backends report %CPU of ONE core (ps convention, up to ncpu × 100);
// 'machine' divides by the core count, as Task Manager does.
type CpuScale = 'core' | 'machine'

function cpuColor(cpu: number): 'red' | 'amber' | 'gray' {
  return cpu >= 50 ? 'red' : cpu >= 15 ? 'amber' : 'gray'
}

// ps etime: [[dd-]hh:]mm:ss → seconds, so Elapsed sorts by duration, not text
function etimeSecs(s: string): number {
  const [days, clock] = s.includes('-') ? s.split('-') : ['0', s]
  return clock.split(':').reduce((acc, n) => acc * 60 + +n, 0) + +days * 86400
}

function sortValue(row: unknown, key: string): unknown {
  const v = (row as Record<string, unknown>)[key]
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
  // null until chosen: then Windows defaults to Task Manager's whole-machine %
  const [cpuPick, setCpuPick] = useState<CpuScale | null>(null)

  useEffect(() => {
    tiny.store.get('cpuScale').then((v) => { if (v === 'core' || v === 'machine') setCpuPick(v) })
  }, [])
  const pickCpuScale = (v: string) => {
    setCpuPick(v as CpuScale)
    tiny.store.set('cpuScale', v)
  }

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
  const cpuScale: CpuScale = cpuPick ?? (win ? 'machine' : 'core')
  const cpuDiv = cpuScale === 'machine' && sys?.ncpu ? sys.ncpu : 1

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

  const q = filter.trim().toLowerCase()
  const shownProcs = useMemo(() => {
    const rows = q
      ? procs.filter((p) =>
          p.name.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) ||
          String(p.pid) === q)
      : procs
    return sortBy(rows, procSort)
  }, [procs, q, procSort])

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
            <SegmentedControl.Root size="1" className="cpu-scale" value={cpuScale}
              onValueChange={pickCpuScale}>
              {/* native title, not <Tooltip>: Radix's tooltip trigger writes its own
                  data-state ("closed") over the item's "on", and the selection
                  indicator keys on that — it silently vanished */}
              <SegmentedControl.Item value="core"
                title="Like ps/top: a process keeping two cores busy shows 200">
                100% = 1 core
              </SegmentedControl.Item>
              <SegmentedControl.Item value="machine"
                title={`Like Task Manager: share of all ${sys?.ncpu || ''} cores together`.replace('  ', ' ')}>
                100% = all cores
              </SegmentedControl.Item>
            </SegmentedControl.Root>
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
                  <SortHeader label="CPU %" k="cpu" sort={procSort} onSort={setProcSort} align="right" />
                  <SortHeader label="Mem %" k="mem" sort={procSort} onSort={setProcSort} align="right" />
                  <SortHeader label="RSS" k="rss" sort={procSort} onSort={setProcSort} align="right" />
                  <SortHeader label="Elapsed" k="etime" sort={procSort} onSort={setProcSort} align="right" />
                  <Table.ColumnHeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {shownProcs.map((p) => (
                  <Table.Row key={p.pid} align="center">
                    <Table.Cell><Code size="1" variant="ghost">{p.pid}</Code></Table.Cell>
                    <Table.RowHeaderCell>
                      <Tooltip content={p.path || p.name}><Text size="1" className="clip">{p.name}</Text></Tooltip>
                    </Table.RowHeaderCell>
                    <Table.Cell><Text size="1" color="gray">{p.user}</Text></Table.Cell>
                    <Table.Cell className="num">
                      {/* heat stays per-core on either scale: 1.4 busy cores is
                          hot even when it reads 9% of a 16-core machine */}
                      <Badge size="1" color={cpuColor(p.cpu)} variant="soft">{(p.cpu / cpuDiv).toFixed(1)}</Badge>
                    </Table.Cell>
                    <Table.Cell className="num"><Text size="1">{p.mem.toFixed(1)}</Text></Table.Cell>
                    <Table.Cell className="num"><Text size="1">{fmtRss(p.rss)}</Text></Table.Cell>
                    <Table.Cell className="num"><Text size="1" color="gray">{p.etime}</Text></Table.Cell>
                    <Table.Cell>
                      <RowMenu
                        win={win}
                        onQuit={() => kill(p.pid, p.name, false)}
                        onKill={() => kill(p.pid, p.name, true)}
                        copies={[['Copy PID', String(p.pid)], ['Copy Path', p.path]]}
                      />
                    </Table.Cell>
                  </Table.Row>
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
              ? `${shownProcs.length} of ${procs.length} processes`
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

function RowMenu({ win, onQuit, onKill, copies }: {
  win: boolean; onQuit: () => void; onKill: () => void; copies: [string, string][]
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <IconButton size="1" variant="ghost"><DotsHorizontalIcon /></IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content size="1">
        <DropdownMenu.Item onSelect={onQuit}>{win ? 'Quit' : 'Quit (SIGTERM)'}</DropdownMenu.Item>
        <DropdownMenu.Item color="red" onSelect={onKill}>{win ? 'Force Kill' : 'Force Kill (SIGKILL)'}</DropdownMenu.Item>
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
