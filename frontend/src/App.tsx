import { useCallback, useEffect, useState, type ReactNode } from "react";

type Packet = { hash: string; packetId: string; ttl: number; hops: number; tampered: boolean };
type Device = { id: string; owner: string | null; bridge: boolean; online: boolean; partition: string; x: number; y: number; packets: Packet[] };
type Event = { seq: number; at: number; round: number; type: string; message: string; transfers?: { from: string; to: string; hash: string }[]; outcome?: string };
type Account = { vpa: string; name: string; balance_paise: number };
type Tx = { id: number; packet_hash: string; sender: string; receiver: string; amount_paise: number; status: string; reason: string | null; settled_at: string; bridge_node: string | null; hop_count: number | null };
type Processed = { packet_hash: string; outcome: string; reason: string | null; bridge_node: string | null; received_at: string };
type State = { mesh: { round: number; devices: Device[]; links: [string, string][]; events: Event[] }; ledger: { accounts: Account[]; transactions: Tx[]; processed: Processed[]; totalPaise: number }; simulation: boolean; sandbox?: { isolated: boolean; idleMinutes: number } };
type Scenario = { scenario: string; description: string; outcomes: string[]; reason?: string };

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (h: string) => `${h.slice(0, 8)}…`;
const cx = (...p: (string | false | null | undefined)[]) => p.filter(Boolean).join(" ");
const PART: Record<string, string> = { A: "#0b1f3a", B: "#7c3aed", C: "#c2410c" };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error?.message ?? `Request failed (${r.status})`);
  return j as T;
}

function Card({ title, sub, actions, children, className }: { title: string; sub?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("min-w-0 rounded-lg border border-rule bg-card", className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-4 py-3">
        <div><h2 className="text-sm font-semibold">{title}</h2>{sub && <p className="mt-0.5 text-xs text-quiet">{sub}</p>}</div>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Outcome({ v }: { v: string }) {
  const t: Record<string, string> = { SETTLED: "bg-emerald-soft text-emerald-800 border-emerald-300", DUPLICATE_DROPPED: "bg-sky-50 text-sky-800 border-sky-200", INVALID: "bg-red-50 text-red-800 border-red-200", REJECTED: "bg-amber-50 text-amber-800 border-amber-300", PENDING: "bg-wash text-quiet border-rule" };
  return <span className={cx("inline-block rounded border px-1.5 py-0.5 font-mono text-[0.68rem]", t[v] ?? t.PENDING)}>{v}</span>;
}

function NetworkMap({ s, lastTransfers, selected, onSelect }: { s: State["mesh"]; lastTransfers: Set<string>; selected: string | null; onSelect: (id: string) => void }) {
  const pos = new Map(s.devices.map((d) => [d.id, d]));
  return (
    <svg viewBox="0 0 700 380" className="h-auto w-full rounded-md bg-wash" role="img" aria-label={`Mesh network: ${s.devices.length} devices; ${s.devices.filter((d) => d.online).length} online`}>
      <rect x={560} y={20} width={130} height={340} rx={10} fill="#ecfdf5" stroke="#a7f3d0" strokeDasharray="4 4" />
      <text x={625} y={42} textAnchor="middle" fontSize="11" fill="#047857">internet / 4G</text>
      {s.links.map(([a, b]) => {
        const A = pos.get(a)!, B = pos.get(b)!;
        const active = lastTransfers.has(`${a}|${b}`) || lastTransfers.has(`${b}|${a}`);
        const usable = A.online && B.online && A.partition === B.partition;
        return <line key={`${a}-${b}`} x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={active ? "#059669" : usable ? "#cfccc1" : "#e4e2da"} strokeWidth={active ? 3.5 : 1.5} strokeDasharray={usable ? undefined : "4 5"} />;
      })}
      {s.devices.map((d) => (
        <g key={d.id} transform={`translate(${d.x} ${d.y})`} onClick={() => onSelect(d.id)} className="cursor-pointer" role="button" tabIndex={0} aria-label={`${d.id}, ${d.online ? "online" : "offline"}, holds ${d.packets.length} packets`} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(d.id)}>
          <circle r={26} fill={d.online ? "#fff" : "#f0efe9"} stroke={selected === d.id ? "#059669" : PART[d.partition]} strokeWidth={selected === d.id ? 3.5 : 2} strokeDasharray={d.online ? undefined : "4 3"} />
          {d.bridge ? (
            <g fill="none" stroke={d.online ? "#059669" : "#5a6475"} strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <path d="M-9 -2a12 12 0 0 1 18 0" /><path d="M-5 2a6 6 0 0 1 10 0" /><circle cx={0} cy={6} r={1.8} fill={d.online ? "#059669" : "#5a6475"} />
            </g>
          ) : (
            <g aria-hidden="true">
              <rect x={-7} y={-11} width={14} height={22} rx={3} fill="none" stroke={d.online ? "#0b1f3a" : "#5a6475"} strokeWidth={2} />
              <circle cx={0} cy={7} r={1.3} fill={d.online ? "#0b1f3a" : "#5a6475"} />
            </g>
          )}
          <text textAnchor="middle" y={44} fontSize="11" fontWeight={600} fill={d.online ? "#0b1f3a" : "#5a6475"}>{d.id}</text>
          <text textAnchor="middle" y={57} fontSize="9.5" fill="#5a6475">{d.online ? `partition ${d.partition}` : "offline"}</text>
          {d.packets.length > 0 && (
            <g transform="translate(18 -20)">
              <circle r={10} fill={d.packets.some((p) => p.tampered) ? "#dc2626" : "#059669"} />
              <text textAnchor="middle" y={4} fontSize="10" fill="#fff" fontWeight={700}>{d.packets.length}</text>
            </g>
          )}
        </g>
      ))}
    </svg>
  );
}

export default function App() {
  const [s, setS] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sender, setSender] = useState("alice@demo");
  const [receiver, setReceiver] = useState("bob@demo");
  const [amount, setAmount] = useState("250");
  const [selected, setSelected] = useState<string | null>(null);
  const [lastTransfers, setLast] = useState<Set<string>>(new Set());
  const [scen, setScen] = useState<Scenario[]>([]);

  const refresh = useCallback(async () => {
    try { setS(await call<State>("/api/state")); } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { await refresh(); setBusy(false); }
  };

  const gossip = () => act(async () => {
    const r = await call<{ transfers: { from: string; to: string }[] }>("/api/mesh/gossip", {});
    setLast(new Set(r.transfers.map((t) => `${t.from}|${t.to}`)));
  });

  const sel = s?.mesh.devices.find((d) => d.id === selected) ?? null;
  const withPhones = ["alice@demo", "bob@demo", "carol@demo"];

  return (
    <div className="min-h-dvh">
      <div className="bg-navy px-4 py-2 text-center text-xs text-white">Simulation only — fictional accounts and balances. No real money, UPI IDs, bank data or devices are involved.{s?.sandbox?.isolated && <> This sandbox is private to you and is cleared after {s.sandbox.idleMinutes} minutes idle.</>}</div>
      <header className="border-b border-rule bg-card">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <img src="/favicon.svg" alt="" className="h-8 w-8" />
            <div><h1 className="text-base font-semibold">UPI Offline Mesh</h1><p className="text-xs text-quiet">Offline payment network simulation · Node.js · Express · PostgreSQL</p></div>
          </div>
          <a className="text-sm text-quiet hover:text-navy" href="https://github.com/parasar0810/UpiWithoutInternet" target="_blank" rel="noreferrer">GitHub ↗</a>
        </div>
      </header>

      <main className="mx-auto max-w-[1240px] space-y-5 px-4 py-6 sm:px-6">
        {err && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
        {!s && !err && <p role="status" className="text-sm text-quiet">Loading simulation…</p>}
        {s && (
          <>
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <Card title="Mesh network" sub={`Gossip round ${s.mesh.round}. Green edges: transfers in the last round. Click a device to change its state.`}
                actions={<div className="flex gap-2">
                  <button type="button" disabled={busy} onClick={gossip} className="rounded-md bg-navy px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Run gossip round</button>
                  <button type="button" disabled={busy} onClick={() => act(() => call("/api/mesh/flush", {}))} className="rounded-md bg-emerald px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Bridges upload</button>
                </div>}>
                <NetworkMap s={s.mesh} lastTransfers={lastTransfers} selected={selected} onSelect={setSelected} />
                {sel && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-rule p-3 text-sm">
                    <span className="font-semibold">{sel.id}</span>
                    <button type="button" disabled={busy} onClick={() => act(() => call(`/api/mesh/devices/${sel.id}`, { online: !sel.online }))} className="rounded border border-rule-strong px-2 py-1 text-xs">{sel.online ? "Disconnect" : "Reconnect"}</button>
                    <label className="flex items-center gap-1.5 text-xs text-quiet">Partition
                      <select value={sel.partition} onChange={(e) => act(() => call(`/api/mesh/devices/${sel.id}`, { partition: e.target.value }))} className="rounded border border-rule-strong px-1 py-0.5 text-navy">
                        {["A", "B", "C"].map((p) => <option key={p}>{p}</option>)}
                      </select>
                    </label>
                    <span className="text-xs text-quiet">{sel.packets.length ? sel.packets.map((p) => `${short(p.hash)} ttl ${p.ttl}${p.tampered ? " (tampered)" : ""}`).join(" · ") : "holds no packets"}</span>
                  </div>
                )}
              </Card>

              <div className="space-y-5">
                <Card title="New offline payment" sub="The sender’s phone signs (Ed25519) and encrypts (AES-256-GCM + RSA-OAEP) the payment, then holds it.">
                  <form onSubmit={(e) => { e.preventDefault(); void act(() => call("/api/payments", { sender, receiver, amountRupees: Number(amount) })); }} className="space-y-3 text-sm">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs text-quiet">From<select value={sender} onChange={(e) => setSender(e.target.value)} className="mt-1 block w-full rounded border border-rule-strong px-2 py-1.5 text-sm text-navy">{withPhones.map((v) => <option key={v}>{v}</option>)}</select></label>
                      <label className="text-xs text-quiet">To<select value={receiver} onChange={(e) => setReceiver(e.target.value)} className="mt-1 block w-full rounded border border-rule-strong px-2 py-1.5 text-sm text-navy">{s.ledger.accounts.map((a) => <option key={a.vpa}>{a.vpa}</option>)}</select></label>
                    </div>
                    <label className="block text-xs text-quiet">Amount (₹, simulated)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 block w-full rounded border border-rule-strong px-2 py-1.5 text-sm text-navy" /></label>
                    <button type="submit" disabled={busy || sender === receiver} className="w-full rounded-md bg-navy px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Create payment on {sender.split("@")[0]}’s phone</button>
                  </form>
                </Card>
                <Card title="Accounts" sub={`Total in system: ${rupees(s.ledger.totalPaise)} — conserved by every settlement.`}
                  actions={<button type="button" disabled={busy} onClick={() => act(async () => { await call("/api/reset", {}); setLast(new Set()); setScen([]); })} className="rounded border border-rule-strong px-2 py-1 text-xs">Reset demo</button>}>
                  <table className="w-full text-sm"><tbody>{s.ledger.accounts.map((a) => <tr key={a.vpa} className="border-t border-rule first:border-0"><td className="py-1.5">{a.name} <span className="font-mono text-xs text-quiet">{a.vpa}</span></td><td className="py-1.5 text-right font-mono tabular-nums">{rupees(a.balance_paise)}</td></tr>)}</tbody></table>
                </Card>
              </div>
            </div>

            <Card title="Security & failure lab" sub="Each button runs a real scenario through the same ingestion path bridges use, and shows what the backend decided.">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {[["concurrent-duplicates", "5 bridges deliver the same packet at once"], ["replay", "Re-submit a settled packet"], ["tampered", "Relay flips one ciphertext bit"], ["forged-sender", "Payment signed by the wrong device"], ["expired", "Payment signed 25 h ago"], ["insufficient-balance", "Spend more than the balance"]].map(([id, label]) => (
                  <button key={id} type="button" disabled={busy} onClick={() => act(async () => { const r = await call<Scenario>(`/api/scenarios/${id}`, {}); setScen((x) => [r, ...x].slice(0, 6)); })}
                    className="rounded-md border border-rule-strong px-3 py-2 text-left text-sm hover:border-navy disabled:opacity-50">
                    <span className="block font-medium">{label}</span><span className="font-mono text-[0.68rem] text-quiet">{id}</span>
                  </button>
                ))}
              </div>
              {scen.length > 0 && (
                <ul className="mt-4 divide-y divide-rule border-t border-rule">
                  {scen.map((r, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                      <span className="min-w-0 flex-1">{r.description}</span>
                      <span className="flex flex-wrap gap-1">{r.outcomes.map((o, j) => <Outcome key={j} v={o} />)}</span>
                      {r.reason && <span className="font-mono text-xs text-quiet">{r.reason}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card title="Settlement ledger" sub="PostgreSQL transactions table (latest 50).">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[480px] text-left text-sm">
                    <thead><tr className="text-xs text-quiet"><th className="pb-1 font-medium">#</th><th className="pb-1 font-medium">Payment</th><th className="pb-1 pr-4 text-right font-medium">Amount</th><th className="pb-1 font-medium">Status</th><th className="pb-1 font-medium">Via</th></tr></thead>
                    <tbody>{s.ledger.transactions.map((t) => <tr key={t.id} className="border-t border-rule"><td className="py-1.5 font-mono text-xs">{t.id}</td><td className="py-1.5 text-xs">{t.sender} → {t.receiver}</td><td className="py-1.5 pr-4 text-right font-mono tabular-nums">{rupees(t.amount_paise)}</td><td className="py-1.5"><Outcome v={t.status} /></td><td className="py-1.5 font-mono text-xs text-quiet">{t.bridge_node ?? "—"}{t.hop_count != null ? ` · ${t.hop_count} hops` : ""}</td></tr>)}</tbody>
                  </table>
                  {!s.ledger.transactions.length && <p className="py-2 text-sm text-quiet">No settlements yet.</p>}
                </div>
              </Card>
              <Card title="Backend packet log" sub="Every packet hash the backend has seen, with its outcome.">
                <ul className="max-h-72 space-y-1 overflow-auto text-xs">
                  {s.ledger.processed.map((p) => <li key={p.packet_hash} className="flex items-center gap-2"><span className="font-mono text-quiet">{short(p.packet_hash)}</span><Outcome v={p.outcome} />{p.reason && <span className="font-mono text-quiet">{p.reason}</span>}<span className="ml-auto text-quiet">{p.bridge_node}</span></li>)}
                  {!s.ledger.processed.length && <li className="text-sm text-quiet">Nothing received yet.</li>}
                </ul>
              </Card>
            </div>

            <Card title="Event log" sub="Simulation events, newest first.">
              <ol className="max-h-64 space-y-1 overflow-auto font-mono text-xs">
                {[...s.mesh.events].reverse().map((e) => <li key={e.seq} className="flex gap-3"><span className="w-14 shrink-0 text-quiet">r{e.round}</span><span className={cx(e.outcome === "INVALID" && "text-red-700", e.outcome === "SETTLED" && "text-emerald-700")}>{e.message}</span></li>)}
              </ol>
            </Card>

            <Card title="How it works">
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-navy-2">
                <li>The sender’s phone signs the payment with its Ed25519 key, then encrypts payment + signature with a fresh AES-256-GCM key wrapped by the server’s RSA-OAEP key.</li>
                <li>Phones gossip packets to neighbours in range (one hop per round, TTL 5). Relays see only ciphertext and drop copies they already hold (by SHA-256 of the ciphertext).</li>
                <li>When a bridge has internet it uploads everything it carries — often the same packet as another bridge, at the same time.</li>
                <li>The backend claims the packet hash and settles inside one PostgreSQL transaction: decrypt, verify signature, check freshness, lock accounts in a fixed order, debit, credit, record. Duplicates lose the claim; failures roll back.</li>
              </ol>
              <p className="mt-3 text-xs text-quiet">Guarantee: at most one committed settlement per packet within this database. Delivery through the mesh is at-least-once by design. This is deferred settlement: the receiver cannot verify funds offline, and a sender could double-spend across disconnected groups until one packet reaches the backend first.</p>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
